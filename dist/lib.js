export class SNComponentManager {

  /*
    @param {string} environment: one of [web, desktop, mobile]
    @param {string} platform: one of [ios, android, linux-${environment}, mac-${environment}, windows-${environment}]
  */
  constructor({modelManager, syncManager, desktopManager, nativeExtManager,
    alertManager, $uiRunner, $timeout, environment, platform}) {
    /* This domain will be used to save context item client data */
    SNComponentManager.ClientDataDomain = "org.standardnotes.sn.components";

    // Some actions need to be run on the ui thread (desktop/web only)
    this.$uiRunner = $uiRunner || ((fn) => {fn()});
    this.$timeout = $timeout || setTimeout.bind(window);

    this.modelManager = modelManager;
    this.syncManager = syncManager;
    this.desktopManager = desktopManager;
    this.nativeExtManager = nativeExtManager;
    this.alertManager = alertManager;

    this.streamObservers = [];
    this.contextStreamObservers = [];
    this.activeComponents = [];

    this.environment = environment;
    this.platform = platform;
    this.isDesktop = this.environment == "desktop";
    this.isMobile = this.environment == "mobile";

    if(environment != "mobile") {
      this.configureForNonMobileUsage();
    }

    this.configureForGeneralUsage();

    // this.loggingEnabled = true;

    this.permissionDialogs = [];

    this.handlers = [];
  }

  configureForGeneralUsage() {
    this.modelManager.addItemSyncObserver("component-manager", "*", (allItems, validItems, deletedItems, source, sourceKey) => {

      /* If the source of these new or updated items is from a Component itself saving items, we don't need to notify
        components again of the same item. Regarding notifying other components than the issuing component, other mapping sources
        will take care of that, like SFModelManager.MappingSourceRemoteSaved

        Update: We will now check sourceKey to determine whether the incoming change should be sent to
        a component. If sourceKey == component.uuid, it will be skipped. This way, if one component triggers a change,
        it's sent to other components.
       */
      // if(source == SFModelManager.MappingSourceComponentRetrieved) {
      //   return;
      // }

      let syncedComponents = allItems.filter((item) => {
        return item.content_type === "SN|Component" || item.content_type == "SN|Theme"
      });

      /* We only want to sync if the item source is Retrieved, not MappingSourceRemoteSaved to avoid
        recursion caused by the component being modified and saved after it is updated.
      */
      if(syncedComponents.length > 0 && source != SFModelManager.MappingSourceRemoteSaved) {
        // Ensure any component in our data is installed by the system
        if(this.isDesktop) {
          this.desktopManager.syncComponentsInstallation(syncedComponents);
        }
      }

      for(var component of syncedComponents) {
        var activeComponent = _.find(this.activeComponents, {uuid: component.uuid});
        if(component.active && !component.deleted && !activeComponent) {
          this.activateComponent(component);
        } else if(!component.active && activeComponent) {
          this.deactivateComponent(component);
        }
      }

      for(let observer of this.streamObservers) {
        if(sourceKey && sourceKey == observer.component.uuid) {
          // Don't notify source of change, as it is the originator, doesn't need duplicate event.
          continue;
        }

        let relevantItems = allItems.filter((item) => {
          return observer.contentTypes.indexOf(item.content_type) !== -1;
        })

        if(relevantItems.length == 0) {
          continue;
        }

        let requiredPermissions = [{
          name: "stream-items",
          content_types: observer.contentTypes.sort()
        }];

        this.runWithPermissions(observer.component, requiredPermissions, () => {
          this.sendItemsInReply(observer.component, relevantItems, observer.originalMessage);
        })
      }

      let requiredContextPermissions = [{
        name: "stream-context-item"
      }];

      for(let observer of this.contextStreamObservers) {
        if(sourceKey && sourceKey == observer.component.uuid) {
          // Don't notify source of change, as it is the originator, doesn't need duplicate event.
          continue;
        }

        for(let handler of this.handlers) {
          if(!handler.areas.includes(observer.component.area) && !handler.areas.includes("*")) {
            continue;
          }
          if(handler.contextRequestHandler) {
            var itemInContext = handler.contextRequestHandler(observer.component);
            if(itemInContext) {
              var matchingItem = _.find(allItems, {uuid: itemInContext.uuid});
              if(matchingItem) {
                this.runWithPermissions(observer.component, requiredContextPermissions, () => {
                  this.sendContextItemInReply(observer.component, matchingItem, observer.originalMessage, source);
                })
              }
            }
          }
        }
      }
    });
  }

  configureForNonMobileUsage() {
    const detectFocusChange = (event) => {
      for(var component of this.activeComponents) {
        if(document.activeElement == this.iframeForComponent(component)) {
          this.$timeout(() => {
            this.focusChangedForComponent(component);
          })
          break;
        }
      }
    }

    window.addEventListener ? window.addEventListener('focus', detectFocusChange, true) : window.attachEvent('onfocusout', detectFocusChange);
    window.addEventListener ? window.addEventListener('blur', detectFocusChange, true) : window.attachEvent('onblur', detectFocusChange);

    this.desktopManager.registerUpdateObserver((component) => {
      // Reload theme if active
      if(component.active && component.isTheme()) {
        this.postActiveThemesToAllComponents();
      }
    })

    // On mobile, events listeners are handled by a respective component
    window.addEventListener("message", (event) => {
      if(this.loggingEnabled) {
        console.log("Web app: received message", event);
      }

      // Make sure this message is for us
      if(event.data.sessionKey) {
        this.handleMessage(this.componentForSessionKey(event.data.sessionKey), event.data);
      }
    }, false);
  }

  postActiveThemesToAllComponents() {
    for(let component of this.components) {
      // Skip over components that are themes themselves,
      // or components that are not active, or components that don't have a window
      if(component.isTheme() || !component.active || !component.window) {
        continue;
      }

      this.postActiveThemesToComponent(component);
    }
  }

  getActiveThemes() {
    return this.componentsForArea("themes").filter((theme) => {return theme.active});
  }

  urlsForActiveThemes() {
    let themes = this.getActiveThemes();
    return themes.map((theme) => {
      return this.urlForComponent(theme);
    })
  }

  postActiveThemesToComponent(component) {
    let urls = this.urlsForActiveThemes();
    let data = { themes: urls }

    this.sendMessageToComponent(component, {action: "themes", data: data})
  }

  contextItemDidChangeInArea(area) {
    for(let handler of this.handlers) {
      if(handler.areas.includes(area) === false && !handler.areas.includes("*")) {
        continue;
      }
      var observers = this.contextStreamObservers.filter((observer) => {
        return observer.component.area === area;
      })

      for(let observer of observers) {
        if(handler.contextRequestHandler) {
          var itemInContext = handler.contextRequestHandler(observer.component);
          if(itemInContext) {
            this.sendContextItemInReply(observer.component, itemInContext, observer.originalMessage);
          }
        }
      }
    }
  }

  setComponentHidden(component, hidden) {
    /*
      A hidden component will not receive messages.
      However, when a component is unhidden, we need to send it any items it may have
      registered streaming for.
    */
    if(hidden) {
      component.hidden = true;
    } else if(component.hidden) {
      // Only enter this condition if component is hidden to make this note have double side effects.
      component.hidden = false;

      // streamContextItem
      let contextObserver = _.find(this.contextStreamObservers, {identifier: component.uuid});
      if(contextObserver) {
        this.handleStreamContextItemMessage(component, contextObserver.originalMessage);
      }

      // streamItems
      let streamObserver = _.find(this.streamObservers, {identifier: component.uuid});
      if(streamObserver) {
        this.handleStreamItemsMessage(component, streamObserver.originalMessage);
      }
    }
  }

  jsonForItem(item, component, source) {
    var params = {uuid: item.uuid, content_type: item.content_type, created_at: item.created_at, updated_at: item.updated_at, deleted: item.deleted};
    params.content = item.createContentJSONFromProperties();
    params.clientData = item.getDomainDataItem(component.getClientDataKey(), SNComponentManager.ClientDataDomain) || {};

    /* This means the this function is being triggered through a remote Saving response, which should not update
      actual local content values. The reason is, Save responses may be delayed, and a user may have changed some values
      in between the Save was initiated, and the time it completes. So we only want to update actual content values (and not just metadata)
      when its another source, like SFModelManager.MappingSourceRemoteRetrieved.

      3/7/18: Add MappingSourceLocalSaved as well to handle fully offline saving. github.com/standardnotes/forum/issues/169
     */
    if(source && (source == SFModelManager.MappingSourceRemoteSaved || source == SFModelManager.MappingSourceLocalSaved)) {
      params.isMetadataUpdate = true;
    }
    this.removePrivatePropertiesFromResponseItems([params], component);
    return params;
  }

  sendItemsInReply(component, items, message, source) {
    if(this.loggingEnabled) {console.log("Web|componentManager|sendItemsInReply", component, items, message)};
    let response = {items: {}};
    let mapped = items.map((item) => {
      return this.jsonForItem(item, component, source);
    });

    response.items = mapped;
    this.replyToMessage(component, message, response);
  }

  sendContextItemInReply(component, item, originalMessage, source) {
    if(this.loggingEnabled) {console.log("Web|componentManager|sendContextItemInReply", component, item, originalMessage)};
    let response = {item: this.jsonForItem(item, component, source)};
    this.replyToMessage(component, originalMessage, response);
  }

  replyToMessage(component, originalMessage, replyData) {
    var reply = {
      action: "reply",
      original: originalMessage,
      data: replyData
    }

    this.sendMessageToComponent(component, reply);
  }

  sendMessageToComponent(component, message) {
    let permissibleActionsWhileHidden = ["component-registered", "themes"];
    if(component.hidden && !permissibleActionsWhileHidden.includes(message.action)) {
      if(this.loggingEnabled) {
        console.log("Component disabled for current item, not sending any messages.", component.name);
      }
      return;
    }

    if(this.loggingEnabled) {
      console.log("Web|sendMessageToComponent", component, message);
    }

    var origin = this.urlForComponent(component, "file://");
    if(!origin.startsWith("http") && !origin.startsWith("file")) {
      // Native extension running in web, prefix current host
      origin = window.location.href + origin;
    }

    if(!component.window) {
      this.alertManager.alert({text: `Standard Notes is trying to communicate with ${component.name}, but an error is occurring. Please restart this extension and try again.`})
    }

    // Mobile messaging requires json
    if(this.isMobile) {
      message = JSON.stringify(message);
    }

    component.window.postMessage(message, origin);
  }

  get components() {
    return this.modelManager.allItemsMatchingTypes(["SN|Component", "SN|Theme"]);
  }

  componentsForArea(area) {
    return this.components.filter((component) => {
      return component.area === area;
    })
  }

  urlForComponent(component, offlinePrefix = "") {
    if(component.offlineOnly || (this.isDesktop && component.local_url)) {
      return component.local_url && component.local_url.replace("sn://", offlinePrefix + this.desktopManager.getApplicationDataPath() + "/");
    } else {
      let url = component.hosted_url || component.legacy_url;
      if(this.isMobile) {
        let localReplacement = this.platform == "ios" ? "localhost" : "10.0.2.2";
        url = url.replace("localhost", localReplacement).replace("sn.local", localReplacement);
      }
      return url;
    }
  }

  componentForUrl(url) {
    return this.components.filter((component) => {
      return component.hosted_url === url || component.legacy_url === url;
    })[0];
  }

  componentForSessionKey(key) {
    let component = _.find(this.components, {sessionKey: key});
    if(!component) {
      for(let handler of this.handlers) {
        if(handler.componentForSessionKeyHandler) {
          component = handler.componentForSessionKeyHandler(key);
          if(component) {
            break;
          }
        }
      }
    }
    return component;
  }

  handleMessage(component, message) {

    if(!component) {
      console.log("Component not defined for message, returning", message);
      this.alertManager.alert({text: "An extension is trying to communicate with Standard Notes, but there is an error establishing a bridge. Please restart the app and try again."});
      return;
    }

    // Actions that won't succeeed with readonly mode
    let readwriteActions = [
      "save-items",
      "associate-item",
      "deassociate-item",
      "create-item",
      "create-items",
      "delete-items",
      "set-component-data"
    ];

    if(component.readonly && readwriteActions.includes(message.action)) {
      // A component can be marked readonly if changes should not be saved.
      // Particullary used for revision preview windows where the notes should not be savable.
      this.alertManager.alert({text: `The extension ${component.name} is trying to save, but it is in a locked state and cannot accept changes.`});
      return;
    }

    /**
    Possible Messages:
      set-size
      stream-items
      stream-context-item
      save-items
      select-item
      associate-item
      deassociate-item
      clear-selection
      create-item
      create-items
      delete-items
      set-component-data
      install-local-component
      toggle-activate-component
      request-permissions
      present-conflict-resolution
    */

    if(message.action === "stream-items") {
      this.handleStreamItemsMessage(component, message);
    } else if(message.action === "stream-context-item") {
      this.handleStreamContextItemMessage(component, message);
    } else if(message.action === "set-component-data") {
      this.handleSetComponentDataMessage(component, message);
    } else if(message.action === "delete-items") {
      this.handleDeleteItemsMessage(component, message);
    } else if(message.action === "create-items" || message.action === "create-item") {
      this.handleCreateItemsMessage(component, message);
    } else if(message.action === "save-items") {
      this.handleSaveItemsMessage(component, message);
    } else if(message.action === "toggle-activate-component") {
      let componentToToggle = this.modelManager.findItem(message.data.uuid);
      this.handleToggleComponentMessage(component, componentToToggle, message);
    } else if(message.action === "request-permissions") {
      this.handleRequestPermissionsMessage(component, message);
    } else if(message.action === "install-local-component") {
      this.handleInstallLocalComponentMessage(component, message);
    } else if(message.action === "duplicate-item") {
      this.handleDuplicateItemMessage(component, message);
    }

    // Notify observers
    for(let handler of this.handlers) {
      if(handler.actionHandler && (handler.areas.includes(component.area) || handler.areas.includes("*"))) {
        this.$timeout(() => {
          handler.actionHandler(component, message.action, message.data);
        })
      }
    }
  }

  removePrivatePropertiesFromResponseItems(responseItems, component, options = {}) {
    if(component) {
      // System extensions can bypass this step
      if(this.nativeExtManager && this.nativeExtManager.isSystemExtension(component)) {
        return;
      }
    }
    // Don't allow component to overwrite these properties.
    let privateProperties = ["autoupdateDisabled", "permissions", "active"];
    if(options) {
      if(options.includeUrls) { privateProperties = privateProperties.concat(["url", "hosted_url", "local_url"])}
    }
    for(let responseItem of responseItems) {
      // Do not pass in actual items here, otherwise that would be destructive.
      // Instead, generic JS/JSON objects should be passed.
      console.assert(typeof responseItem.setDirty !== 'function');

      for(var prop of privateProperties) {
        delete responseItem.content[prop];
      }
    }
  }

  handleStreamItemsMessage(component, message) {
    let requiredPermissions = [
      {
        name: "stream-items",
        content_types: message.data.content_types.sort()
      }
    ];

    this.runWithPermissions(component, requiredPermissions, () => {
      if(!_.find(this.streamObservers, {identifier: component.uuid})) {
        // for pushing laster as changes come in
        this.streamObservers.push({
          identifier: component.uuid,
          component: component,
          originalMessage: message,
          contentTypes: message.data.content_types
        })
      }

      // push immediately now
      var items = [];
      for(var contentType of message.data.content_types) {
        items = items.concat(this.modelManager.validItemsForContentType(contentType));
      }
      this.sendItemsInReply(component, items, message);
    });
  }

  handleStreamContextItemMessage(component, message) {

    var requiredPermissions = [
      {
        name: "stream-context-item"
      }
    ];

    this.runWithPermissions(component, requiredPermissions, () => {
      if(!_.find(this.contextStreamObservers, {identifier: component.uuid})) {
        // for pushing laster as changes come in
        this.contextStreamObservers.push({
          identifier: component.uuid,
          component: component,
          originalMessage: message
        })
      }

      // push immediately now
      for(let handler of this.handlersForArea(component.area)) {
        if(handler.contextRequestHandler) {
          var itemInContext = handler.contextRequestHandler(component);
          if(itemInContext) {
            this.sendContextItemInReply(component, itemInContext, message);
          }
        }
      }
    })
  }

  isItemIdWithinComponentContextJurisdiction(uuid, component) {
    let itemIdsInJurisdiction = this.itemIdsInContextJurisdictionForComponent(component);
    return itemIdsInJurisdiction.includes(uuid);
  }

  /* Returns items that given component has context permissions for */
  itemIdsInContextJurisdictionForComponent(component) {
    let itemIds = [];
    for(let handler of this.handlersForArea(component.area)) {
      if(handler.contextRequestHandler) {
        var itemInContext = handler.contextRequestHandler(component);
        if(itemInContext) {
          itemIds.push(itemInContext.uuid);
        }
      }
    }

    return itemIds;
  }

  handlersForArea(area) {
    return this.handlers.filter((candidate) => {return candidate.areas.includes(area)});
  }

  handleSaveItemsMessage(component, message) {
    let responseItems = message.data.items;
    let requiredPermissions = [];

    let itemIdsInContextJurisdiction = this.itemIdsInContextJurisdictionForComponent(component);

    // Pending as in needed to be accounted for in permissions.
    let pendingResponseItems = responseItems.slice();

    for(let responseItem of responseItems.slice()) {
      if(itemIdsInContextJurisdiction.includes(responseItem.uuid)) {
        requiredPermissions.push({
          name: "stream-context-item"
        });
        _.pull(pendingResponseItems, responseItem);
        // We break because there can only be one context item
        break;
      }
    }

    // Check to see if additional privileges are required
    if(pendingResponseItems.length > 0) {
      let requiredContentTypes = _.uniq(pendingResponseItems.map((i) => {return i.content_type})).sort();
      requiredPermissions.push({
        name: "stream-items",
        content_types: requiredContentTypes
      });
    }

    this.runWithPermissions(component, requiredPermissions, () => {

      this.removePrivatePropertiesFromResponseItems(responseItems, component, {includeUrls: true});

      /*
      We map the items here because modelManager is what updates the UI. If you were to instead get the items directly,
      this would update them server side via sync, but would never make its way back to the UI.
      */

      // Filter locked items
      let ids = responseItems.map((i) => {return i.uuid});
      let items = this.modelManager.findItems(ids);
      let lockedCount = 0;
      for(let item of items) {
        if(item.locked) {
          _.remove(responseItems, {uuid: item.uuid});
          lockedCount++;
        }
      }

      if(lockedCount > 0) {
        let itemNoun = lockedCount == 1 ? "item" : "items";
        let auxVerb = lockedCount == 1 ? "is" : "are";
        this.alertManager.alert({title: 'Items Locked', text: `${lockedCount} ${itemNoun} you are attempting to save ${auxVerb} locked and cannot be edited.`});
      }

      let localItems = this.modelManager.mapResponseItemsToLocalModels(responseItems, SFModelManager.MappingSourceComponentRetrieved, component.uuid);

      for(let responseItem of responseItems) {
        let item = _.find(localItems, {uuid: responseItem.uuid});
        if(!item) {
          // An item this extension is trying to save was possibly removed locally, notify user
          this.alertManager.alert({text: `The extension ${component.name} is trying to save an item with type ${responseItem.content_type}, but that item does not exist. Please restart this extension and try again.`});
          continue;
        }

        // 8/2018: Why did we have this here? `mapResponseItemsToLocalModels` takes care of merging item content. We definitely shouldn't be doing this directly.
        // _.merge(item.content, responseItem.content);

        if(!item.locked) {
          if(responseItem.clientData) {
            item.setDomainDataItem(component.getClientDataKey(), responseItem.clientData, SNComponentManager.ClientDataDomain);
          }
          item.setDirty(true);
        }
      }

      this.syncManager.sync().then((response) => {
        // Allow handlers to be notified when a save begins and ends, to update the UI
        let saveMessage = Object.assign({}, message);
        saveMessage.action = response && response.error ? "save-error" : "save-success";
        this.replyToMessage(component, message, {error: response && response.error})
        this.handleMessage(component, saveMessage);
      });
    });
  }

  handleDuplicateItemMessage(component, message) {
    var itemParams = message.data.item;
    var item = this.modelManager.findItem(itemParams.uuid);
    var requiredPermissions = [
      {
        name: "stream-items",
        content_types: [item.content_type]
      }
    ];

    this.runWithPermissions(component, requiredPermissions, () => {
      var duplicate = this.modelManager.duplicateItem(item);
      this.syncManager.sync();

      this.replyToMessage(component, message, {item: this.jsonForItem(duplicate, component)});
    });
  }

  handleCreateItemsMessage(component, message) {
    var responseItems = message.data.item ? [message.data.item] : message.data.items;
    let uniqueContentTypes = _.uniq(responseItems.map((item) => {return item.content_type}));
    var requiredPermissions = [
      {
        name: "stream-items",
        content_types: uniqueContentTypes
      }
    ];

    this.runWithPermissions(component, requiredPermissions, () => {
      this.removePrivatePropertiesFromResponseItems(responseItems, component);
      var processedItems = [];
      for(let responseItem of responseItems) {
        var item = this.modelManager.createItem(responseItem);
        if(responseItem.clientData) {
          item.setDomainDataItem(component.getClientDataKey(), responseItem.clientData, SNComponentManager.ClientDataDomain);
        }
        this.modelManager.addItem(item);
        this.modelManager.resolveReferencesForItem(item, true);
        item.setDirty(true);
        processedItems.push(item);
      }

      this.syncManager.sync();

      // "create-item" or "create-items" are possible messages handled here
      let reply =
        message.action == "create-item" ?
          {item: this.jsonForItem(processedItems[0], component)}
        :
          {items: processedItems.map((item) => {return this.jsonForItem(item, component)})}

      this.replyToMessage(component, message, reply)
    });
  }

  handleDeleteItemsMessage(component, message) {
    var requiredContentTypes = _.uniq(message.data.items.map((i) => {return i.content_type})).sort();
    var requiredPermissions = [
      {
        name: "stream-items",
        content_types: requiredContentTypes
      }
    ];

    this.runWithPermissions(component, requiredPermissions, () => {
      var itemsData = message.data.items;
      var noun = itemsData.length == 1 ? "item" : "items";
      var reply = null;
      if(confirm(`Are you sure you want to delete ${itemsData.length} ${noun}?`)) {
        // Filter for any components and deactivate before deleting
        for(var itemData of itemsData) {
          var model = this.modelManager.findItem(itemData.uuid);
          if(["SN|Component", "SN|Theme"].includes(model.content_type)) {
            this.deactivateComponent(model, true);
          }
          this.modelManager.setItemToBeDeleted(model);
          // Currently extensions are not notified of association until a full server sync completes.
          // We manually notify observers.
          this.modelManager.notifySyncObserversOfModels([model], SFModelManager.MappingSourceRemoteSaved);
        }

        this.syncManager.sync();
        reply = {deleted: true};
      } else {
        // Rejected by user
        reply = {deleted: false};
      }

      this.replyToMessage(component, message, reply)
    });
  }

  handleRequestPermissionsMessage(component, message) {
    this.runWithPermissions(component, message.data.permissions, () => {
      this.replyToMessage(component, message, {approved: true});
    });
  }

  handleSetComponentDataMessage(component, message) {
    // A component setting its own data does not require special permissions
    this.runWithPermissions(component, [], () => {
      component.componentData = message.data.componentData;
      component.setDirty(true);
      this.syncManager.sync();
    });
  }

  handleToggleComponentMessage(sourceComponent, targetComponent, message) {
    this.toggleComponent(targetComponent);
  }

  toggleComponent(component) {
    if(component.area == "modal") {
      this.openModalComponent(component);
    } else {
      if(component.active) {
        this.deactivateComponent(component);
      } else {
        if(component.content_type == "SN|Theme") {
          // Deactive currently active theme if new theme is not layerable
          var activeThemes = this.getActiveThemes();

          // Activate current before deactivating others, so as not to flicker
          this.activateComponent(component);

          if(!component.isLayerable()) {
            setTimeout(() => {
              for(var theme of activeThemes) {
                if(theme && !theme.isLayerable()) {
                  this.deactivateComponent(theme);
                }
              }
            }, 10);
          }
        } else {
          this.activateComponent(component);
        }
      }
    }
  }

  handleInstallLocalComponentMessage(sourceComponent, message) {
    // Only extensions manager has this permission
    if(this.nativeExtManager && !this.nativeExtManager.isSystemExtension(sourceComponent)) {
      return;
    }

    let targetComponent = this.modelManager.findItem(message.data.uuid);
    this.desktopManager.installComponent(targetComponent);
  }

  runWithPermissions(component, requiredPermissions, runFunction) {
    if(!component.permissions) {
      component.permissions = [];
    }

    // Make copy as not to mutate input values
    requiredPermissions = JSON.parse(JSON.stringify(requiredPermissions));

    var acquiredPermissions = component.permissions;

    for(let required of requiredPermissions.slice()) {
      // Remove anything we already have
      let respectiveAcquired = acquiredPermissions.find((candidate) => candidate.name == required.name);
      if(!respectiveAcquired) {
        continue;
      }

      // We now match on name, lets substract from required.content_types anything we have in acquired.
      let requiredContentTypes = required.content_types;

      if(!requiredContentTypes) {
        // If this permission does not require any content types (i.e stream-context-item)
        // then we can remove this from required since we match by name (respectiveAcquired.name == required.name)
        _.pull(requiredPermissions, required);
        continue;
      }

      for(let acquiredContentType of respectiveAcquired.content_types) {
        // console.log("Removing content_type", acquiredContentType, "from", requiredContentTypes);
        _.pull(requiredContentTypes, acquiredContentType);
      }

      if(requiredContentTypes.length == 0)  {
        // We've removed all acquired and end up with zero, means we already have all these permissions
        _.pull(requiredPermissions, required);
      }
    }

    if(requiredPermissions.length > 0) {
      this.promptForPermissions(component, requiredPermissions, (approved) => {
        if(approved) {
          runFunction();
        }
      });
    } else {
      runFunction();
    }
  }

  promptForPermissions(component, permissions, callback) {
    var params = {};
    params.component = component;
    params.permissions = permissions;
    params.permissionsString = this.permissionsStringForPermissions(permissions, component);
    params.actionBlock = callback;

    params.callback = (approved) => {
      if(approved) {
        for(let permission of permissions) {
          let matchingPermission = component.permissions.find((candidate) => candidate.name == permission.name);
          if(!matchingPermission) {
            component.permissions.push(permission);
          } else {
            // Permission already exists, but content_types may have been expanded
            matchingPermission.content_types = _.uniq(matchingPermission.content_types.concat(permission.content_types));
          }
        }
        component.setDirty(true);
        this.syncManager.sync();
      }

      this.permissionDialogs = this.permissionDialogs.filter((pendingDialog) => {
        // Remove self
        if(pendingDialog == params) {
          pendingDialog.actionBlock && pendingDialog.actionBlock(approved);
          return false;
        }

        /* Use with numbers and strings, not objects */
        const containsObjectSubset = function(source, target) {
          return !target.some(val => !source.find((candidate) => candidate == val));
        }

        if(pendingDialog.component == component) {
          // remove pending dialogs that are encapsulated by already approved permissions, and run its function
          if(pendingDialog.permissions == permissions || containsObjectSubset(permissions, pendingDialog.permissions)) {
            // If approved, run the action block. Otherwise, if canceled, cancel any pending ones as well, since the user was
            // explicit in their intentions
            if(approved) {
              pendingDialog.actionBlock && pendingDialog.actionBlock(approved);
            }
            return false;
          }
        }
        return true;
      })

      if(this.permissionDialogs.length > 0) {
        this.presentPermissionsDialog(this.permissionDialogs[0]);
      }
    };

    // since these calls are asyncronous, multiple dialogs may be requested at the same time. We only want to present one and trigger all callbacks based on one modal result
    var existingDialog = _.find(this.permissionDialogs, {component: component});

    this.permissionDialogs.push(params);

    if(!existingDialog) {
      this.presentPermissionsDialog(params);
    } else {
      console.log("Existing dialog, not presenting.");
    }
  }

  presentPermissionsDialog(dialog) {
    console.error("Must override");
  }

  openModalComponent(component) {
    console.error("Must override");
  }

  registerHandler(handler) {
    this.handlers.push(handler);
  }

  deregisterHandler(identifier) {
    var handler = _.find(this.handlers, {identifier: identifier});
    if(!handler) {
      console.log("Attempting to deregister non-existing handler");
      return;
    }
    this.handlers.splice(this.handlers.indexOf(handler), 1);
  }

  // Called by other views when the iframe is ready
  async registerComponentWindow(component, componentWindow) {
    if(component.window === componentWindow) {
      if(this.loggingEnabled) {
        console.log("Web|componentManager", "attempting to re-register same component window.")
      }
    }

    if(this.loggingEnabled) {
      console.log("Web|componentManager|registerComponentWindow", component);
    }
    component.window = componentWindow;
    component.sessionKey = await SFJS.crypto.generateUUID();
    this.sendMessageToComponent(component, {
      action: "component-registered",
      sessionKey: component.sessionKey,
      componentData: component.componentData,
      data: {
        uuid: component.uuid,
        environment: this.environment,
        platform: this.platform,
        activeThemeUrls: this.urlsForActiveThemes()
      }
    });

    this.postActiveThemesToComponent(component);

    if(this.desktopManager) {
      this.desktopManager.notifyComponentActivation(component);
    }
  }

  activateComponent(component, dontSync = false) {
    var didChange = component.active != true;

    component.active = true;
    for(let handler of this.handlers) {
      if(handler.areas.includes(component.area) || handler.areas.includes("*")) {
        // We want to run the handler in a $timeout so the UI updates, but we also don't want it to run asyncronously
        // so that the steps below this one are run before the handler. So we run in a waitTimeout.
        // Update 12/18: We were using this.waitTimeout previously, however, that caused the iframe.onload callback to never be called
        // for some reason for iframes on desktop inside the revision-preview-modal. So we'll use safeApply instead. I'm not quite sure
        // where the original "so the UI updates" comment applies to, but we'll have to keep an eye out to see if this causes problems somewhere else.
        this.$uiRunner(() => {
          handler.activationHandler && handler.activationHandler(component);
        })
      }
    }

    if(didChange && !dontSync) {
      component.setDirty(true);
      this.syncManager.sync();
    }

    if(!this.activeComponents.includes(component)) {
      this.activeComponents.push(component);
    }

    if(component.area == "themes") {
      this.postActiveThemesToAllComponents();
    }
  }

  deactivateComponent(component, dontSync = false) {
    var didChange = component.active != false;
    component.active = false;
    component.sessionKey = null;

    for(let handler of this.handlers) {
      if(handler.areas.includes(component.area) || handler.areas.includes("*")) {
        // See comment in activateComponent regarding safeApply and awaitTimeout
        this.$uiRunner(() => {
          handler.activationHandler && handler.activationHandler(component);
        })
      }
    }

    if(didChange && !dontSync) {
      component.setDirty(true);
      this.syncManager.sync();
    }

    _.pull(this.activeComponents, component);

    this.streamObservers = this.streamObservers.filter((o) => {
      return o.component !== component;
    })

    this.contextStreamObservers = this.contextStreamObservers.filter((o) => {
      return o.component !== component;
    })

    if(component.area == "themes") {
      this.postActiveThemesToAllComponents();
    }
  }

  async reloadComponent(component) {
    //
    // Do soft deactivate
    //
    component.active = false;

    for(let handler of this.handlers) {
      if(handler.areas.includes(component.area) || handler.areas.includes("*")) {
        // See comment in activateComponent regarding safeApply and awaitTimeout
        this.$uiRunner(() => {
          handler.activationHandler && handler.activationHandler(component);
        })
      }
    }

    this.streamObservers = this.streamObservers.filter((o) => {
      return o.component !== component;
    })

    this.contextStreamObservers = this.contextStreamObservers.filter((o) => {
      return o.component !== component;
    })

    if(component.area == "themes") {
      this.postActiveThemesToAllComponents();
    }

    //
    // Do soft activate
    //

    return new Promise((resolve, reject) => {
      this.$timeout(() => {
        component.active = true;
        for(var handler of this.handlers) {
          if(handler.areas.includes(component.area) || handler.areas.includes("*")) {
            // See comment in activateComponent regarding safeApply and awaitTimeout
            this.$uiRunner(() => {
              handler.activationHandler && handler.activationHandler(component);
              resolve();
            })
          }
        }

        if(!this.activeComponents.includes(component)) {
          this.activeComponents.push(component);
        }

        if(component.area == "themes") {
          this.postActiveThemesToAllComponents();
        }
        // Resolve again in case first resolve in for loop isn't reached.
        // Should be no effect if resolved twice, only first will be used.
        resolve();
      })
    })
  }

  deleteComponent(component) {
    this.modelManager.setItemToBeDeleted(component);
    this.syncManager.sync();
  }

  isComponentActive(component) {
    return component.active;
  }

  iframeForComponent(component) {
    for(var frame of Array.from(document.getElementsByTagName("iframe"))) {
      var componentId = frame.dataset.componentId;
      if(componentId === component.uuid) {
        return frame;
      }
    }
  }

  focusChangedForComponent(component) {
    let focused = document.activeElement == this.iframeForComponent(component);
    for(var handler of this.handlers) {
      // Notify all handlers, and not just ones that match this component type
      handler.focusHandler && handler.focusHandler(component, focused);
    }
  }

  handleSetSizeEvent(component, data) {
    var setSize = (element, size) => {
      var widthString = typeof size.width === 'string' ? size.width : `${data.width}px`;
      var heightString = typeof size.height === 'string' ? size.height : `${data.height}px`;
      if(element) {
        element.setAttribute("style", `width:${widthString}; height:${heightString};`);
      }
    }

    if(component.area == "rooms" || component.area == "modal") {
      var selector = component.area == "rooms" ? "inner" : "outer";
      var content = document.getElementById(`component-content-${selector}-${component.uuid}`);
      if(content) {
        setSize(content, data);
      }
    } else {
      var iframe = this.iframeForComponent(component);
      if(!iframe) {
        return;
      }

      setSize(iframe, data);

      // On Firefox, resizing a component iframe does not seem to have an effect with editor-stack extensions.
      // Sizing the parent does the trick, however, we can't do this globally, otherwise, areas like the note-tags will
      // not be able to expand outside of the bounds (to display autocomplete, for example).
      if(component.area == "editor-stack") {
        let parent = iframe.parentElement;
        if(parent) {
          setSize(parent, data);
        }
      }

      // content object in this case is === to the iframe object above. This is probably
      // legacy code from when we would size content and container individually, which we no longer do.
      // var content = document.getElementById(`component-iframe-${component.uuid}`);
      // console.log("content === iframe", content == iframe);
      // if(content) {
      //   setSize(content, data);
      // }
    }
  }

  editorForNote(note) {
    let editors = this.componentsForArea("editor-editor");
    for(var editor of editors) {
      if(editor.isExplicitlyEnabledForItem(note)) {
        return editor;
      }
    }

    // No editor found for note. Use default editor, if note does not prefer system editor
    if(this.isMobile) {
      if(!note.content.mobilePrefersPlainEditor) {
        return this.getDefaultEditor();
      }
    } else {
      if(!note.getAppDataItem("prefersPlainEditor")) {
        return editors.filter((e) => {return e.isDefaultEditor()})[0];
      }
    }
  }

  permissionsStringForPermissions(permissions, component) {
    var finalString = "";
    let permissionsCount = permissions.length;

    let addSeparator = (index, length) => {
      if(index > 0) {
        if(index == length - 1) {
          if(length == 2) {
            return " and ";
          } else {
            return ", and "
          }
        } else {
          return ", ";
        }
      }

      return "";
    }

    permissions.forEach((permission, index) => {
      if(permission.name === "stream-items") {
        var types = permission.content_types.map((type) => {
          var desc = this.modelManager.humanReadableDisplayForContentType(type);
          if(desc) {
            return desc + "s";
          } else {
            return "items of type " + type;
          }
        })
        var typesString = "";

        for(var i = 0;i < types.length;i++) {
          var type = types[i];
          typesString += addSeparator(i, types.length + permissionsCount - index - 1);
          typesString += type;
        }

        finalString += addSeparator(index, permissionsCount);

        finalString += typesString;

        if(types.length >= 2 && index < permissionsCount - 1) {
          // If you have a list of types, and still an additional root-level permission coming up, add a comma
          finalString += ", ";
        }
      } else if(permission.name === "stream-context-item") {
        var mapping = {
          "editor-stack" : "working note",
          "note-tags" : "working note",
          "editor-editor": "working note"
        }

        finalString += addSeparator(index, permissionsCount, true);

        finalString += mapping[component.area];
      }
    })

    return finalString + ".";
  }
}
;export class SNComponent extends SFItem {

  constructor(json_obj) {
    // If making a copy of an existing component (usually during sign in if you have a component active in the session),
    // which may have window set, you may get a cross-origin exception since you'll be trying to copy the window. So we clear it here.
    json_obj.window = null;

    super(json_obj);

    if(!this.componentData) {
      this.componentData = {};
    }

    if(!this.disassociatedItemIds) {
      this.disassociatedItemIds = [];
    }

    if(!this.associatedItemIds) {
      this.associatedItemIds = [];
    }
  }

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    /* Legacy */
    // We don't want to set the url directly, as we'd like to phase it out.
    // If the content.url exists, we'll transfer it to legacy_url
    // We'll only need to set this if content.hosted_url is blank, otherwise, hosted_url is the url replacement.
    if(!content.hosted_url) {
      this.legacy_url = content.url;
    }

    /* New */
    this.local_url = content.local_url;
    this.hosted_url = content.hosted_url || content.url;
    this.offlineOnly = content.offlineOnly;

    if(content.valid_until) {
      this.valid_until = new Date(content.valid_until);
    }

    this.name = content.name;
    this.autoupdateDisabled = content.autoupdateDisabled;

    this.package_info = content.package_info;

    // the location in the view this component is located in. Valid values are currently tags-list, note-tags, and editor-stack`
    this.area = content.area;

    this.permissions = content.permissions;
    if(!this.permissions) {
      this.permissions = [];
    }

    this.active = content.active;

    // custom data that a component can store in itself
    this.componentData = content.componentData || {};

    // items that have requested a component to be disabled in its context
    this.disassociatedItemIds = content.disassociatedItemIds || [];

    // items that have requested a component to be enabled in its context
    this.associatedItemIds = content.associatedItemIds || [];
  }

  handleDeletedContent() {
    super.handleDeletedContent();

    this.active = false;
  }

  structureParams() {
    var params = {
      legacy_url: this.legacy_url,
      hosted_url: this.hosted_url,
      local_url: this.local_url,
      valid_until: this.valid_until,
      offlineOnly: this.offlineOnly,
      name: this.name,
      area: this.area,
      package_info: this.package_info,
      permissions: this.permissions,
      active: this.active,
      autoupdateDisabled: this.autoupdateDisabled,
      componentData: this.componentData,
      disassociatedItemIds: this.disassociatedItemIds,
      associatedItemIds: this.associatedItemIds,
    };

    var superParams = super.structureParams();
    Object.assign(superParams, params);
    return superParams;
  }

  get content_type() {
    return "SN|Component";
  }

  isEditor() {
    return this.area == "editor-editor";
  }

  isTheme() {
    return this.content_type == "SN|Theme" || this.area == "themes";
  }

  isDefaultEditor() {
    return this.getAppDataItem("defaultEditor") == true;
  }

  setLastSize(size) {
    this.setAppDataItem("lastSize", size);
  }

  getLastSize() {
    return this.getAppDataItem("lastSize");
  }

  acceptsThemes() {
    if(this.content.package_info && "acceptsThemes" in this.content.package_info) {
      return this.content.package_info.acceptsThemes;
    }
    return true;
  }

  /*
    The key used to look up data that this component may have saved to an item.
    This key will be look up on the item, and not on itself.
   */
  getClientDataKey() {
    if(this.legacy_url) {
      return this.legacy_url;
    } else {
      return this.uuid;
    }
  }

  hasValidHostedUrl() {
    return this.hosted_url || this.legacy_url;
  }

  keysToIgnoreWhenCheckingContentEquality() {
    return ["active", "disassociatedItemIds", "associatedItemIds"].concat(super.keysToIgnoreWhenCheckingContentEquality());
  }


  /*
    An associative component depends on being explicitly activated for a given item, compared to a dissaciative component,
    which is enabled by default in areas unrelated to a certain item.
   */
   static associativeAreas() {
     return ["editor-editor"];
   }

  isAssociative() {
    return Component.associativeAreas().includes(this.area);
  }

  associateWithItem(item) {
    this.associatedItemIds.push(item.uuid);
  }

  isExplicitlyEnabledForItem(item) {
    return this.associatedItemIds.indexOf(item.uuid) !== -1;
  }

  isExplicitlyDisabledForItem(item) {
    return this.disassociatedItemIds.indexOf(item.uuid) !== -1;
  }
}
;export class SNEditor extends SFItem {

  constructor(json_obj) {
    super(json_obj);
    if(!this.notes) {
      this.notes = [];
    }
    if(!this.data) {
      this.data = {};
    }
  }

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    this.url = content.url;
    this.name = content.name;
    this.data = content.data || {};
    this.default = content.default;
    this.systemEditor = content.systemEditor;
  }

  structureParams() {
    var params = {
      url: this.url,
      name: this.name,
      data: this.data,
      default: this.default,
      systemEditor: this.systemEditor
    };

    var superParams = super.structureParams();
    Object.assign(superParams, params);
    return superParams;
  }

  referenceParams() {
    var references = _.map(this.notes, function(note){
      return {uuid: note.uuid, content_type: note.content_type};
    })

    return references;
  }

  addItemAsRelationship(item) {
    if(item.content_type == "Note") {
      if(!_.find(this.notes, item)) {
        this.notes.push(item);
      }
    }
    super.addItemAsRelationship(item);
  }

  removeItemAsRelationship(item) {
    if(item.content_type == "Note") {
      _.pull(this.notes, item);
    }
    super.removeItemAsRelationship(item);
  }

  removeAndDirtyAllRelationships() {
    super.removeAndDirtyAllRelationships();
    this.notes = [];
  }

  removeReferencesNotPresentIn(references) {
    super.removeReferencesNotPresentIn(references);

    var uuids = references.map(function(ref){return ref.uuid});
    this.notes.forEach(function(note){
      if(!uuids.includes(note.uuid)) {
        _.remove(this.notes, {uuid: note.uuid});
      }
    }.bind(this))
  }

  potentialItemOfInterestHasChangedItsUUID(newItem, oldUUID, newUUID) {
    if(newItem.content_type === "Note" && _.find(this.notes, {uuid: oldUUID})) {
      _.remove(this.notes, {uuid: oldUUID});
      this.notes.push(newItem);
    }
  }

  get content_type() {
    return "SN|Editor";
  }

  setData(key, value) {
    var dataHasChanged = JSON.stringify(this.data[key]) !== JSON.stringify(value);
    if(dataHasChanged) {
      this.data[key] = value;
      return true;
    }
    return false;
  }

  dataForKey(key) {
    return this.data[key] || {};
  }
}
;export class Action {
  constructor(json) {
    _.merge(this, json);
    this.running = false; // in case running=true was synced with server since model is uploaded nondiscriminatory
    this.error = false;
    if(this.lastExecuted) {
      // is string
      this.lastExecuted = new Date(this.lastExecuted);
    }
  }
}

export class SNExtension extends SFItem {
  constructor(json) {
      super(json);

      if(json.actions) {
        this.actions = json.actions.map(function(action){
          return new Action(action);
        })
      }

      if(!this.actions) {
        this.actions = [];
      }
  }

  actionsWithContextForItem(item) {
    return this.actions.filter(function(action){
      return action.context == item.content_type || action.context == "Item";
    })
  }

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    this.description = content.description;
    this.url = content.url;
    this.name = content.name;
    this.package_info = content.package_info;
    this.supported_types = content.supported_types;
    if(content.actions) {
      this.actions = content.actions.map(function(action){
        return new Action(action);
      })
    }
  }

  get content_type() {
    return "Extension";
  }

  structureParams() {
    var params = {
      name: this.name,
      url: this.url,
      package_info: this.package_info,
      description: this.description,
      actions: this.actions.map((a) => {return _.omit(a, ["subrows", "subactions"])}),
      supported_types: this.supported_types
    };

    var superParams = super.structureParams();
    Object.assign(superParams, params);
    return superParams;
  }

}
;export class SNNote extends SFItem {

  constructor(json_obj) {
    super(json_obj);

    if(!this.text) {
      // Some external editors can't handle a null value for text.
      // Notes created on mobile with no text have a null value for it,
      // so we'll just set a default here.
      this.text = "";
    }

    if(!this.tags) {
      this.tags = [];
    }
  }

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    this.title = content.title;
    this.text = content.text;
  }

  structureParams() {
    var params = {
      title: this.title,
      text: this.text
    };

    var superParams = super.structureParams();
    Object.assign(superParams, params);
    return superParams;
  }

  addItemAsRelationship(item) {
    /*
    Legacy.
    Previously, note/tag relationships were bidirectional, however in some cases there
    may be broken links such that a note has references to a tag and not vice versa.
    Now, only tags contain references to notes. For old notes that may have references to tags,
    we want to transfer them over to the tag.
     */
    if(item.content_type == "Tag") {
      item.addItemAsRelationship(this);
    }
    super.addItemAsRelationship(item);
  }

  setIsBeingReferencedBy(item) {
    super.setIsBeingReferencedBy(item);
    this.clearSavedTagsString();
  }

  setIsNoLongerBeingReferencedBy(item) {
    super.setIsNoLongerBeingReferencedBy(item);
    this.clearSavedTagsString();
  }

  isBeingRemovedLocally() {
    this.tags.forEach(function(tag){
      _.remove(tag.notes, {uuid: this.uuid});
    }.bind(this))
    super.isBeingRemovedLocally();
  }

  static filterDummyNotes(notes) {
    var filtered = notes.filter(function(note){return note.dummy == false || note.dummy == null});
    return filtered;
  }

  informReferencesOfUUIDChange(oldUUID, newUUID) {
    super.informReferencesOfUUIDChange();
    for(var tag of this.tags) {
      _.remove(tag.notes, {uuid: oldUUID});
      tag.notes.push(this);
    }
  }

  tagDidFinishSyncing(tag) {
    this.clearSavedTagsString();
  }

  safeText() {
    return this.text || "";
  }

  safeTitle() {
    return this.title || "";
  }

  get content_type() {
    return "Note";
  }

  get displayName() {
    return "Note";
  }

  clearSavedTagsString() {
    this.savedTagsString = null;
  }

  tagsString() {
    this.savedTagsString = SNTag.arrayToDisplayString(this.tags);
    return this.savedTagsString;
  }
}
;export class SNTag extends SFItem {

  constructor(json_obj) {
    super(json_obj);

    if(!this.content_type) {
      this.content_type = "Tag";
    }

    if(!this.notes) {
      this.notes = [];
    }
  }

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    this.title = content.title;
  }

  structureParams() {
    var params = {
      title: this.title
    };

    var superParams = super.structureParams();
    Object.assign(superParams, params);
    return superParams;
  }

  addItemAsRelationship(item) {
    if(item.content_type == "Note") {
      if(!_.find(this.notes, {uuid: item.uuid})) {
        this.notes.push(item);
        item.tags.push(this);
      }
    }
    super.addItemAsRelationship(item);
  }

  removeItemAsRelationship(item) {
    if(item.content_type == "Note") {
      _.remove(this.notes, {uuid: item.uuid});
      _.remove(item.tags, {uuid: this.uuid});
    }
    super.removeItemAsRelationship(item);
  }

  updateLocalRelationships() {
    var references = this.content.references;

    var uuids = references.map(function(ref){return ref.uuid});
    this.notes.slice().forEach(function(note){
      if(!uuids.includes(note.uuid)) {
        _.remove(note.tags, {uuid: this.uuid});
        _.remove(this.notes, {uuid: note.uuid});

        note.setIsNoLongerBeingReferencedBy(this);
      }
    }.bind(this))
  }

  isBeingRemovedLocally() {
    this.notes.forEach((note) => {
      _.remove(note.tags, {uuid: this.uuid});
      note.setIsNoLongerBeingReferencedBy(this);
    })

    this.notes.length = 0;

    super.isBeingRemovedLocally();
  }

  informReferencesOfUUIDChange(oldUUID, newUUID) {
    for(var note of this.notes) {
      _.remove(note.tags, {uuid: oldUUID});
      note.tags.push(this);
    }
  }

  didFinishSyncing() {
    for(var note of this.notes) {
      note.tagDidFinishSyncing(this);
    }
  }

  isSmartTag() {
    return this.content_type == "SN|SmartTag";
  }

  get displayName() {
    return "Tag";
  }

  static arrayToDisplayString(tags) {
    return tags.sort((a, b) => {return a.title > b.title}).map(function(tag, i){
      return "#" + tag.title;
    }).join(" ");
  }
}
;export class SNEncryptedStorage extends SFItem {

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    this.storage = content.storage;
  }

  get content_type() {
    return "SN|EncryptedStorage";
  }

}
;export class SNMfa extends SFItem {

  constructor(json_obj) {
    super(json_obj);
  }

  // mapContentToLocalProperties(content) {
  //   super.mapContentToLocalProperties(content)
  //   this.serverContent = content;
  // }
  //
  // structureParams() {
  //   return _.merge(this.serverContent, super.structureParams());
  // }

  get content_type() {
    return "SF|MFA";
  }

  doNotEncrypt() {
    return true;
  }

}
;export class SNServerExtension extends SFItem {

  mapContentToLocalProperties(content) {
    super.mapContentToLocalProperties(content)
    this.url = content.url;
  }

  get content_type() {
    return "SF|Extension";
  }

  doNotEncrypt() {
    return true;
  }
}
;export class SNSmartTag extends SNTag {

  constructor(json_ob) {
    super(json_ob);
    this.content_type = "SN|SmartTag";
  }

  static systemSmartTags() {
    return [
      new SNSmartTag({
        uuid: SNSmartTag.SystemSmartTagIdAllNotes,
        dummy: true,
        content: {
          title: "All notes",
          isSystemTag: true,
          isAllTag: true,
          predicate: new SFPredicate.fromArray(["content_type", "=", "Note"])
        }
      }),
      new SNSmartTag({
        uuid: SNSmartTag.SystemSmartTagIdArchivedNotes,
        dummy: true,
        content: {
          title: "Archived",
          isSystemTag: true,
          isArchiveTag: true,
          predicate: new SFPredicate.fromArray(["archived", "=", true])
        }
      }),
      new SNSmartTag({
        uuid: SNSmartTag.SystemSmartTagIdTrashedNotes,
        dummy: true,
        content: {
          title: "Trash",
          isSystemTag: true,
          isTrashTag: true,
          predicate: new SFPredicate.fromArray(["content.trashed", "=", true])
        }
      })
    ]
  }
}

SNSmartTag.SystemSmartTagIdAllNotes = "all-notes";
SNSmartTag.SystemSmartTagIdArchivedNotes = "archived-notes";
SNSmartTag.SystemSmartTagIdTrashedNotes = "trashed-notes";
;export class SNTheme extends SNComponent {

  constructor(json_obj) {
    super(json_obj);
    this.area = "themes";
  }

  isLayerable() {
    return this.package_info && this.package_info.layerable;
  }

  get content_type() {
    return "SN|Theme";
  }

  get displayName() {
    return "Theme";
  }

  setMobileRules(rules) {
    this.setAppDataItem("mobileRules", rules);
  }

  getMobileRules() {
    return this.getAppDataItem("mobileRules") || {constants: {}, rules: {}};
  }

  // Same as getMobileRules but without default value
  hasMobileRules() {
    return this.getAppDataItem("mobileRules");
  }

  setNotAvailOnMobile(na) {
    this.setAppDataItem("notAvailableOnMobile", na);
  }

  getNotAvailOnMobile() {
    return this.getAppDataItem("notAvailableOnMobile");
  }

  /* We must not use .active because if you set that to true, it will also activate that theme on desktop/web */
  setMobileActive(active) {
    this.setAppDataItem("mobileActive", active);
  }

  isMobileActive() {
    return this.getAppDataItem("mobileActive");
  }
}
;import {SFItem} from 'standard-file-js';

if(typeof window !== 'undefined' && window !== null) {
  // window is for some reason defined in React Native, but throws an exception when you try to set to it
  try {
    window.SNNote = SNNote;
    window.SNTag = SNTag;
    window.SNSmartTag = SNSmartTag;
    window.SNMfa = SNMfa;
    window.SNServerExtension = SNServerExtension;
    window.SNComponent = SNComponent;
    window.SNEditor = SNEditor;
    window.SNExtension = SNExtension;
    window.SNTheme = SNTheme;
    window.SNEncryptedStorage = SNEncryptedStorage;
    window.SNComponentManager = SNComponentManager;
  } catch (e) {
    console.log("Exception while exporting snjs window variables", e);
  }
}
