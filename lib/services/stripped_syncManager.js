import pull from 'lodash/pull';
import { SNModelManager } from '@Services/modelManager';
import { SNHttpManager } from '@Services/httpManager';
import { SERVER_STORAGE_KEY } from '@Protocol/storageKeys';
import { CreatePayloadFromAnyObject } from '@Protocol/payloads/generator';
import {
  ENCRYPTION_INTENT_SYNC,
  ENCRYPTION_INTENT_LOCAL_STORAGE_PREFER_ENCRYPTED
} from '@Protocol/intents';
import {
  MAPPING_SOURCE_REMOTE_RETRIEVED,
  MAPPING_SOURCE_REMOTE_SAVED,
  MAPPING_SOURCE_LOCAL_SAVED,
  MAPPING_SOURCE_LOCAL_RETRIEVED
} from '@Lib/sources';
import {
  SYNC_EVENT_ENTER_OUT_OF_SYNC,
  SYNC_EVENT_EXIT_OUT_OF_SYNC
} from '@Lib/events';

export class SNSyncManager {

  constructor({
    modelManager,
    storageManager,
    protocolManager,
    httpManager,
    authManager,
    timeout,
    interval
  }) {
    SNSyncManager.KeyRequestLoadLocal = "KeyRequestLoadLocal";
    SNSyncManager.KeyRequestSaveLocal = "KeyRequestSaveLocal";
    SNSyncManager.KeyRequestLoadSaveAccount = "KeyRequestLoadSaveAccount";

    if(!storageManager || !protocolManager || !modelManager || !httpManager || !authManager) {
      throw 'Invalid SyncManager construction.';
    }

    this.protocolManager = protocolManager;
    this.httpManager = httpManager;
    this.modelManager = modelManager;
    this.storageManager = storageManager;
    this.authManager = authManager;
    // The number of changed items that constitute a major change
    // This is used by the desktop app to create backups
    this.MajorDataChangeThreshold = 15;
  }

  async getServerURL() {
    return await this.storageManager.getValue(SERVER_STORAGE_KEY) || window._default_sf_server;
  }

  async getSyncURL() {
    return await this.getServerURL() + '/items/sync';
  }

  async writeItemsToLocalStorage(items, offlineOnly) {
    if(items.length == 0) {
      return;
    }

    return new Promise(async (resolve, reject) => {
      let nonDeletedItems = [], deletedItems = [];
      for(let item of items) {
        // if the item is deleted and dirty it means we still need to sync it.
        if(item.deleted === true && !item.dirty) {deletedItems.push(item);}
        else {nonDeletedItems.push(item);}
      }

      if(deletedItems.length > 0) {
        await Promise.all(deletedItems.map(async (deletedItem) => {
          return this.storageManager.deletePayloadWithId(deletedItem.uuid);
        }))
      }

      if(nonDeletedItems.length > 0) {
        let params = await Promise.all(nonDeletedItems.map(async (item) => {
          const payload = CreatePayloadFromAnyObject({object: item});
          const encryptedPayload = await this.protocolManager.payloadByEncryptingPayload({
            payload: payload,
            intent: ENCRYPTION_INTENT_LOCAL_STORAGE_PREFER_ENCRYPTED
          })
          return encryptedPayload;
        })).catch((e) => {
          console.error("Error generating export parameters:", e);
          reject(e)
        });

        await this.storageManager.savePayloads(params).catch((error) => {
          console.error("Error writing items", error);
          this.syncStatus.localError = error;
          this.syncStatusDidChange();
          reject();
        });

        // on success
        if(this.syncStatus.localError) {
          this.syncStatus.localError = null;
          this.syncStatusDidChange();
        }
      }
      resolve();
    })
  }

  async syncOffline(items) {
    for(let item of items) {
      item.updated_at = new Date();
    }
    return this.writeItemsToLocalStorage(items, true).then((responseItems) => {
      for(let item of items) {
        if(item.deleted) { this.modelManager.removeItemLocally(item);}
      }

      this.modelManager.clearDirtyItems(items);
      // Required in order for modelManager to notify sync observers
      this.modelManager.didSyncModelsOffline(items);

      this.notifyEvent("sync:completed", {savedItems: items});
      return {saved_items: items};
    })
  }

  /*
    In the case of signing in and merging local data, we alternative UUIDs
    to avoid overwriting data a user may retrieve that has the same UUID.
    Alternating here forces us to to create duplicates of the items instead.
   */
  async markAllItemsDirtyAndSaveOffline(alternateUUIDs) {

    if(alternateUUIDs) {
      // use a copy, as alternating uuid will affect array
      let originalItems = this.modelManager.allNondummyItems.filter((item) => {return !item.errorDecrypting}).slice();
      for(let item of originalItems) {
        // Update: the last params has been removed. Defaults to true.
        // Old: alternateUUIDForItem last param is a boolean that controls whether the original item
        // should be removed locally after new item is created. We set this to true, since during sign in,
        // all item ids are alternated, and we only want one final copy of the entire data set.
        // Passing false can be desired sometimes, when for example the app has signed out the user,
        // but for some reason retained their data (This happens in Firefox when using private mode).
        // In this case, we should pass false so that both copies are kept. However, it's difficult to
        // detect when the app has entered this state. We will just use true to remove original items for now.
        await this.modelManager.alternateUUIDForItem(item);
      }
    }

    let allItems = this.modelManager.allNondummyItems;
    for(let item of allItems) { item.setDirty(true); }
    return this.writeItemsToLocalStorage(allItems, false);
  }


  get queuedCallbacks() {
    if(!this._queuedCallbacks) {
      this._queuedCallbacks = [];
    }
    return this._queuedCallbacks;
  }

  clearQueuedCallbacks() {
    this._queuedCallbacks = [];
  }

  callQueuedCallbacks(response) {
    let allCallbacks = this.queuedCallbacks;
    if(allCallbacks.length) {
      for(let eachCallback of allCallbacks) {
        eachCallback(response);
      }
      this.clearQueuedCallbacks();
    }
  }

  beginCheckingIfSyncIsTakingTooLong() {
    if(this.syncStatus.checker) {
      this.stopCheckingIfSyncIsTakingTooLong();
    }
    this.syncStatus.checker = this.$interval(function(){
      // check to see if the ongoing sync is taking too long, alert the user
      let secondsPassed = (new Date() - this.syncStatus.syncStart) / 1000;
      let warningThreshold = 5.0; // seconds
      if(secondsPassed > warningThreshold) {
        this.notifyEvent("sync:taking-too-long");
        this.stopCheckingIfSyncIsTakingTooLong();
      }
    }.bind(this), 500)
  }

  stopCheckingIfSyncIsTakingTooLong() {
    if(this.$interval.hasOwnProperty("cancel")) {
      this.$interval.cancel(this.syncStatus.checker);
    } else {
      clearInterval(this.syncStatus.checker);
    }
    this.syncStatus.checker = null;
  }

  async sync(options = {}) {

      if(this.authManager.offline()) {
        return this.syncOffline(allDirtyItems).then((response) => {
          this.syncStatus.syncOpInProgress = false;
          resolve(response);
        }).catch((e) => {
          this.notifyEvent("sync-exception", e);
        })
      }

      let isContinuationSync = this.syncStatus.needsMoreSync;
      this.syncStatus.syncStart = new Date();
      this.beginCheckingIfSyncIsTakingTooLong();

      let submitLimit = this.PerSyncItemUploadLimit;
      let subItems = allDirtyItems.slice(0, submitLimit);
      if(subItems.length < allDirtyItems.length) {
        // more items left to be synced, repeat
        this.syncStatus.needsMoreSync = true;
      } else {
        this.syncStatus.needsMoreSync = false;
      }

      if(!isContinuationSync) {
        this.syncStatus.total = allDirtyItems.length;
        this.syncStatus.current = 0;
      }

      // If items are marked as dirty during a long running sync request, total isn't updated
      // This happens mostly in the case of large imports and sync conflicts where duplicated items are created
      if(this.syncStatus.current > this.syncStatus.total) {
        this.syncStatus.total = this.syncStatus.current;
      }

      this.syncStatusDidChange();

      // Perform save after you've updated all status signals above. Presync save can take several seconds in some cases.
      // Write to local storage before beginning sync.
      // This way, if they close the browser before the sync request completes, local changes will not be lost
      await this.writeItemsToLocalStorage(dirtyItemsNotYetSaved, false);
      this.lastDirtyItemsSave = new Date();

      if(options.onPreSyncSave) {
        options.onPreSyncSave();
      }

      // when doing a sync request that returns items greater than the limit, and thus subsequent syncs are required,
      // we want to keep track of all retreived items, then save to local storage only once all items have been retrieved,
      // so that relationships remain intact
      // Update 12/18: I don't think we need to do this anymore, since relationships will now retroactively resolve their relationships,
      // if an item they were looking for hasn't been pulled in yet.
      if(!this.allRetreivedItems) {
        this.allRetreivedItems = [];
      }

      // We also want to do this for savedItems
      if(!this.allSavedItems) {
        this.allSavedItems = [];
      }

      let params = {};
      params.limit = this.ServerItemDownloadLimit;

      if(options.performIntegrityCheck) {
        params.compute_integrity = true;
      }

      try {
        const payloads = [];
        for(let item of subItems) {
          const payload = CreatePayloadFromAnyObject({object: item});
          const encryptedPayload = await this.protocolManager.payloadByEncryptingPayload({
            payload: payload,
            intent: ENCRYPTION_INTENT_SYNC
          })
          payloads.push(encryptedPayload);
        }

        params.items = payloads;
      } catch (e) {
        console.error("Error generating sync item params", e);
        this.notifyEvent("sync-exception", e);
      }

      for(let item of subItems) {
        // Reset dirty counter to 0, since we're about to sync it.
        // This means anyone marking the item as dirty after this will cause it so sync again and not be cleared on sync completion.
        item.dirtyCount = 0;
      }

      params.sync_token = await this.getSyncToken();
      params.cursor_token = await this.getCursorToken();

      params['api'] = SNHttpManager.getApiVersion();

      if(this.loggingEnabled)  {
        console.log("Syncing with params", params);
      }

      try {
        this.httpManager.postAuthenticatedAbsolute(await this.getSyncURL(), params, (response) => {
          this.handleSyncSuccess(subItems, response, options).then(() => {
            resolve(response);
          }).catch((e) => {
            console.error("Caught sync success exception:", e);
            this.handleSyncError(e, null, allDirtyItems).then((errorResponse) => {
              this.notifyEvent("sync-exception", e);
              resolve(errorResponse);
            });
          });
        }, (response, statusCode) => {
          this.handleSyncError(response, statusCode, allDirtyItems).then((errorResponse) => {
            resolve(errorResponse);
          });
        });
      }
      catch(e) {
        console.log("Sync exception caught:", e);
      }
    });
  }

  async _awaitSleep(durationInMs) {
    console.warn("Simulating high latency sync request", durationInMs);
    return new Promise((resolve, reject) => {
      setTimeout(function () {
        resolve();
      }, durationInMs);
    })
  }

  async handleSyncSuccess(syncedItems, response, options) {
    // Used for testing
    if(options.simulateHighLatency) {
      let latency = options.simulatedLatency || 1000;
      await this._awaitSleep(latency);
    }

    this.syncStatus.error = null;

    if(this.loggingEnabled) {
      console.log("Sync response", response);
    }

    let allSavedUUIDs = this.allSavedItems.map((item) => item.uuid);
    let currentRequestSavedUUIDs = response.saved_items.map((savedResponse) => savedResponse.uuid);
    let potentialRetrievedConflicts = [];

    // If we have retrieved an item that has or is being saved, or if the item is locally dirty,
    // filter it out of retrieved_items, and add to potential conflicts.
    response.retrieved_items = response.retrieved_items.filter((retrievedItem) => {
      let isInPreviousSaved = allSavedUUIDs.includes(retrievedItem.uuid);
      let isInCurrentSaved = currentRequestSavedUUIDs.includes(retrievedItem.uuid);
      if(isInPreviousSaved || isInCurrentSaved) {
        potentialRetrievedConflicts.push(retrievedItem);
        return false;
      }

      let localItem = this.modelManager.findItem(retrievedItem.uuid);
      if(localItem && localItem.dirty) {
        potentialRetrievedConflicts.push(retrievedItem);
        return false;
      }
      return true;
    });

    // Clear dirty items after we've finish filtering retrieved_items above, since that depends on dirty items.
    // Check to make sure any subItem hasn't been marked as dirty again while a sync was ongoing
    let itemsToClearAsDirty = [];
    for(let item of syncedItems) {
      if(item.dirtyCount == 0) {
        // Safe to clear as dirty
        itemsToClearAsDirty.push(item);
      }
    }

    this.modelManager.clearDirtyItems(itemsToClearAsDirty);

    let conflictsNeedingSave = [];

    // Any retrieved_items that were filtered from the above retrieved_items.filter should now be
    // looped on to make sure we create conflicts for any retrieved content that differs from local values.
    if(potentialRetrievedConflicts.length > 0) {
      const payloads = potentialRetrievedConflicts.map((conflictCandidate) => {
        return CreatePayloadFromAnyObject({object: conflictCandidate});
      })
      const decryptedPayloads = await this.protocolManager.payloadsByDecryptingPayloads({
        payloads: payloads
      });
      for(const payload of decryptedPayloads) {
        const localItem = this.modelManager.findItem(payload.uuid);
        const remoteContent = payload.content;
        if(!localItem || !remoteContent) {
          continue;
        }
        if(localItem && !localItem.isContentEqualWithNonItemContent(remoteContent)) {
          let tempServerItem = await this.modelManager.createDuplicateItemFromPayload(payload);
          this.modelManager.addDuplicatedItemAsConflict({
            duplicate: tempServerItem,
            duplicateOf: localItem
          });
          conflictsNeedingSave.push(tempServerItem);
        }
      }
    }

    // Map retrieved items to local data
    // Note that deleted items will not be returned
    let retrieved = await this.handleItemsResponse(
      response.retrieved_items,
      null,
      MAPPING_SOURCE_REMOTE_RETRIEVED,
      SNSyncManager.KeyRequestLoadSaveAccount
    );

    // Append items to master list of retrieved items for this ongoing sync operation
    this.allRetreivedItems = this.allRetreivedItems.concat(retrieved);
    this.syncStatus.retrievedCount = this.allRetreivedItems.length;

    // Merge only metadata for saved items
    // we write saved items to disk now because it clears their dirty status then saves
    // if we saved items before completion, we had have to save them as dirty and save them again on success as clean
    const omitFields = ["content", "auth_hash"];

    // Map saved items to local data
    let saved = await this.handleItemsResponse(
      response.saved_items,
      omitFields,
      MAPPING_SOURCE_REMOTE_SAVED,
      SNSyncManager.KeyRequestLoadSaveAccount
    );

    // Append items to master list of saved items for this ongoing sync operation
    this.allSavedItems = this.allSavedItems.concat(saved);

    // 'unsaved' is deprecated and replaced with 'conflicts' in newer version.
    let deprecated_unsaved = response.unsaved;
    await this.deprecated_handleUnsavedItemsResponse(deprecated_unsaved);

    let handledConflicts = (await this.handleConflictsResponse(response.conflicts)) || [];
    conflictsNeedingSave = conflictsNeedingSave.concat(handledConflicts);
    if(conflictsNeedingSave.length > 0) {
      await this.writeItemsToLocalStorage(conflictsNeedingSave, false);
    }
    await this.writeItemsToLocalStorage(saved, false);
    await this.writeItemsToLocalStorage(retrieved, false);

    this.syncStatus.syncOpInProgress = false;
    this.syncStatus.current += syncedItems.length;

    this.syncStatusDidChange();

    // set the sync token at the end, so that if any errors happen above, you can resync
    this.setSyncToken(response.sync_token);
    this.setCursorToken(response.cursor_token);

    this.stopCheckingIfSyncIsTakingTooLong();

    let cursorToken = await this.getCursorToken();
    if(cursorToken || this.syncStatus.needsMoreSync) {
      return new Promise((resolve, reject) => {
        setTimeout(function () {
          this.sync(options).then(resolve);
        }.bind(this), 10); // wait 10ms to allow UI to update
      })
    }

    else if(conflictsNeedingSave.length > 0) {
      // We'll use the conflict sync as the next sync, so performSyncAgainOnCompletion can be turned off.
      this.performSyncAgainOnCompletion = false;
      // Include as part of await/resolve chain
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          this.sync(options).then(resolve);
        }, 10); // wait 10ms to allow UI to update
      });
    }

    else {
      this.syncStatus.retrievedCount = 0;

      // current and total represent what's going up, not what's come down or saved.
      this.syncStatus.current = 0
      this.syncStatus.total = 0

      this.syncStatusDidChange();

      if(
        this.allRetreivedItems.length >= this.majorDataChangeThreshold ||
        saved.length >= this.majorDataChangeThreshold ||
        (deprecated_unsaved && deprecated_unsaved.length >= this.majorDataChangeThreshold) ||
        (conflictsNeedingSave && conflictsNeedingSave.length >= this.majorDataChangeThreshold)
      ) {
        this.notifyEvent("major-data-change");
      }

      this.callQueuedCallbacks(response);
      this.notifyEvent("sync:completed", {retrievedItems: this.allRetreivedItems, savedItems: this.allSavedItems});

      this.allRetreivedItems = [];
      this.allSavedItems = [];

      if(this.performSyncAgainOnCompletion) {
        this.performSyncAgainOnCompletion = false;
        setTimeout(() => {
          this.sync(options);
        }, 10); // wait 10ms to allow UI to update
      }

      return response;
    }
  }

  async handleSyncError(response, statusCode, allDirtyItems) {
    console.error("Sync error: ", response);

    if(statusCode == 401) {
      this.notifyEvent("sync-session-invalid");
    }

    if(!response) {
      response = {error: {message: "Could not connect to server."}};
    } else if(typeof response == 'string') {
      response = {error: {message: response}};
    }

    this.syncStatus.syncOpInProgress = false;
    this.syncStatus.error = response.error;
    this.syncStatusDidChange();

    this.writeItemsToLocalStorage(allDirtyItems, false);
    this.modelManager.didSyncModelsOffline(allDirtyItems);

    this.stopCheckingIfSyncIsTakingTooLong();

    this.notifyEvent("sync:error", response.error);

    this.callQueuedCallbacks({error: "Sync error"});

    return response;
  }

  async handleItemsResponse(responseItems, omitFields, source, keyRequest) {
    const payloads = responseItems.map((responsePayload) => {
      return CreatePayloadFromAnyObject({
        object: responsePayload,
        source: source,
        omit: omitFields
      });
    })
    const decryptedPayloads = await this.protocolManager.payloadsByDecryptingPayloads({payloads});
    const items = await this.modelManager.mapPayloadsToLocalItems({
      payloads: decryptedPayloads,
      source: source
    });

    // During the decryption process, items may be marked as "errorDecrypting". If so, we want to be sure
    // to persist this new state by writing these items back to local storage. When an item's "errorDecrypting"
    // flag is changed, its "errorDecryptingValueChanged" flag will be set, so we can find these items by filtering (then unsetting) below:
    let itemsWithErrorStatusChange = items.filter((item) => {
      let valueChanged = item.errorDecryptingValueChanged;
      // unset after consuming value
      item.errorDecryptingValueChanged = false;
      return valueChanged;
    });
    if(itemsWithErrorStatusChange.length > 0) {
      this.writeItemsToLocalStorage(itemsWithErrorStatusChange, false);
    }

    return items;
  }

  async refreshErroredItems() {
    let erroredItems = this.modelManager.allNondummyItems.filter((item) => {
      return item.errorDecrypting == true
    });
    if(erroredItems.length > 0) {
      return this.handleItemsResponse(
        erroredItems,
        null,
        MAPPING_SOURCE_LOCAL_RETRIEVED,
        SNSyncManager.KeyRequestLoadSaveAccount
      );
    }
  }

  // Legacy API
  async deprecated_handleUnsavedItemsResponse(unsaved) {
    if(!unsaved || unsaved.length == 0) {
      return;
    }

    if(this.loggingEnabled) {
      console.log("Handle Unsaved Items:", unsaved);
    }

    for(let mapping of unsaved) {
      let itemResponse = mapping.item;
      const payload = CreatePayloadFromAnyObject({object: itemResponse});
      const decryptedPayload = await this.protocolManager.payloadByDecryptingPayload({payload: payload});
      let item = this.modelManager.findItem(itemResponse.uuid);

      // Could be deleted
      if(!item) { continue; }

      let error = mapping.error;

      if(error.tag === "uuid_conflict") {
        // UUID conflicts can occur if a user attempts to
        // import an old data archive with uuids from the old account into a new account
        await this.modelManager.alternateUUIDForItem(item);
      }

      else if(error.tag === "sync_conflict") {
        // Create a new item with the same contents of this item if the contents differ
        let dup = await this.modelManager.createDuplicateItemFromPayload(decryptedPayload);
        if(!itemResponse.deleted && !item.isItemContentEqualWith(dup)) {
          this.modelManager.addDuplicatedItemAsConflict({duplicate: dup, duplicateOf: item});
        }
      }
    }
  }

  /*
    Executes a sync request with a blank sync token and high download limit. It will download all items,
    but won't do anything with them other than decrypting, creating respective objects, and returning them to caller. (it does not map them nor establish their relationships)
    The use case came primarly for clients who had ignored a certain content_type in sync, but later issued an update
    indicated they actually did want to start handling that content type. In that case, they would need to download all items
    freshly from the server.
  */
  stateless_downloadAllItems(options = {}) {
    return new Promise(async (resolve, reject) => {
      let params = {
        limit: options.limit || 500,
        sync_token: options.syncToken,
        cursor_token: options.cursorToken,
        content_type: options.contentType,
        event: options.event,
        api: SNHttpManager.getApiVersion()
      };

      try {
        this.httpManager.postAuthenticatedAbsolute(await this.getSyncURL(), params, async (response) => {
          if(!options.retrievedItems) {
            options.retrievedItems = [];
          }

          const encryptedPayloads = response.retrieved_items.map((retrievedPayload) => {
            return CreatePayloadFromAnyObject({
              object: retrievedPayload,
              ource: MAPPING_SOURCE_REMOTE_RETRIEVED
            });
          })
          const decryptedPayloads = await this.protocolManager.payloadsByDecryptingPayloads({
            payloads: encryptedPayloads
          });
          const items = decryptedPayloads.map((payload) => {
            return CreateItemFromPayload(payload);
          });

          options.retrievedItems = options.retrievedItems.concat(items);
          options.syncToken = response.sync_token;
          options.cursorToken = response.cursor_token;

          if(options.cursorToken) {
            this.stateless_downloadAllItems(options).then(resolve);
          } else {
            resolve(options.retrievedItems);
          }
        }, (response, statusCode) => {
          reject(response);
        });
      } catch(e) {
        console.log("Download all items exception caught:", e);
        reject(e);
      }
    });
  }

  async resolveOutOfSync() {
    // Sync all items again to resolve out-of-sync state
    return this.stateless_downloadAllItems({event: "resolve-out-of-sync"}).then(async (downloadedItems) => {
      let payloadsToMap = [];
      for(let downloadedItem of downloadedItems) {
        // Note that deleted items will not be sent back by the server.
        let existingItem = this.modelManager.findItem(downloadedItem.uuid);
        if(existingItem) {
          // Check if the content differs. If it does, create a new item, and do not map downloadedItem.
          let contentDoesntMatch = !downloadedItem.isItemContentEqualWith(existingItem);
          if(contentDoesntMatch) {
            // We create a copy of the local existing item and sync that up. It will be a "conflict" of itself
            await this.modelManager.duplicateItemAndAddAsConflict(existingItem);
          }
        }

        const payload = CreatePayloadFromAnyObject({
          object: downloadedItem,
          source: MAPPING_SOURCE_REMOTE_RETRIEVED
        })

        // Map the downloadedItem as authoritive content. If client copy at all differed, we would have created a duplicate of it above and synced it.
        // This is also neccessary to map the updated_at value from the server
        payloadsToMap.push(payload);
      }

      await this.modelManager.mapPayloadsToLocalItems({
        payloads: payloadsToMap,
        source: MAPPING_SOURCE_REMOTE_RETRIEVED
      });
      // Save all items locally. Usually sync() would save downloaded items locally, but we're using stateless_sync here, so we have to do it manually
      await this.writeItemsToLocalStorage(this.modelManager.allNondummyItems);
      return this.sync({performIntegrityCheck: true});
    })
  }

  async handleSignOut() {
    this.outOfSync = false;
    this.loadLocalDataPromise = null;
    this.performSyncAgainOnCompletion = false;
    this.syncStatus.syncOpInProgress = false;
    this._queuedCallbacks = [];
    this.syncStatus = {};
    return this.clearSyncToken();
  }

  async clearSyncToken() {
    this._syncToken = null;
    this._cursorToken = null;
    return this.storageManager.removeValue("syncToken");
  }

  // Only used by unit test
  __setLocalDataNotLoaded() {
    this.loadLocalDataPromise = null;
    this._initialDataLoaded = false;
  }
}