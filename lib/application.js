import { SNAlertManager } from '@Services/alertManager';
import { SNAuthManager } from '@Services/authManager';
import { SNComponentManager } from '@Services/componentManager';
import { SNDatabaseManager } from '@Services/databaseManager';
import { SNHttpManager } from '@Services/httpManager';
import { SNKeyManager } from '@Services/keyManager';
import { SNMigrationManager } from '@Services/migrationManager';
import { SNModelManager } from '@Services/modelManager';
import { SNSingletonManager } from '@Services/singletonManager';
import { SNStorageManager } from '@Services/storageManager';
import { SNSyncManager } from '@Services/sync/sync_manager';
import {
  APPLICATION_EVENT_WILL_SIGN_IN,
  APPLICATION_EVENT_DID_SIGN_IN,
  APPLICATION_EVENT_DID_SIGN_OUT
} from '@Lib/events';

export class SNApplication {

  /**
   * @param namespace  Optional - a unique identifier to namespace storage and other persistent properties.
   *                   Defaults to empty string.
   */
  constructor({namespace} = {}) {
    this.namespace = namespace || '';
  }

  /**
   * The first thing consumers should call when starting their app.
   * This function will load all services in their correct order and run migrations.
   * It will also handle device authentication, and issue a callback if a device activation
   * requires user input (i.e local passcode or fingerprint).
   * @param keychainDelegate  A SNKeychainDelegate object.
   * @param swapClasses  Gives consumers the ability to provide their own custom subclass for a service.
   *                     swapClasses should be an array of key/value pairs consisting of keys 'swap' and 'with'.
   *                     'swap' is the base class you wish to replace, and 'with' is the custom subclass to use.
   *
   * @param skipClasses  An optional array of classes to skip making services for.
   *
   * @param timeout  A platform-specific function that is fed functions to run when other operations have completed.
   *                 This is similar to setImmediate on the web, or setTimeout(fn, 0).
   *
   * @param interval  A platform-specific function that is fed functions to perform repeatedly. Similar to setInterval.
   * @param callbacks
   *          .onRequiresAuthentication(sources, handleResponses)
   *            @param sources  An array of DeviceAuthenticationSources that require responses.
   *            @param handleResponses  Once the consumer has valid responses for all sources, they must
   *                                    call handleResponses with an array of DeviceAuthenticationResponses.
   */

  async initialize({keychainDelegate, swapClasses, skipClasses, callbacks, timeout, interval}) {
    if(!callbacks.onRequiresAuthentication) {
      throw 'Application.initialize callbacks are not properly configured.';
    }

    if(!timeout) {
      throw `'timeout' is required to initialize application.`
    }

    if(!keychainDelegate) {
      throw 'Keychain delegate must be supplied.';
    }

    // console.log("Initializing application with namespace", this.namespace);

    SFItem.AppDomain = 'org.standardnotes.sn';

    this.swapClasses = swapClasses;
    this.skipClasses = skipClasses;
    this.timeout = timeout;
    this.interval = interval;
    this.eventHandlers = [];

    this.createAlertManager();

    this.createHttpManager();
    this.httpManager.setJWTRequestHandler(async () => {
      return this.storageManager.getValue("jwt");;
    })

    this.createDatabaseManager();
    this.createModelManager();
    this.createProtocolManager();

    this.createStorageManager();
    await this.storageManager.initializeFromDisk();

    this.createKeyManager();
    this.protocolManager.setKeyManager(this.keyManager);
    this.keyManager.setKeychainDelegate(keychainDelegate);

    this.createAuthManager();
    this.createSyncManager();
    await this.syncManager.loadLocalItems();

    this.createSingletonManager();
    // this.createMigrationManager();

    this.createComponentManager();
  }

  addEventHandler(handler) {
    this.eventHandlers.push(handler);
    return handler;
  }

  removeEventHandler(handler) {
    pull(this.eventHandlers, handler);
  }

  notifyEvent(event, data) {
    for(var handler of this.eventHandlers) {
      handler(event, data || {});
    }
  }

  async register({url, email, password, ephemeral}) {
    const result = await this.authManager.register({
      url, email, password, ephemeral
    });
    if(!result.error) {
      await this.keyManager.setRootKey({key: result.rootKey, keyParams: result.keyParams});
      await this.keyManager.createNewItemsKey();
      await this.storageManager.setLocalStoragePolicy({encrypt: true, ephemeral: ephemeral});
      await this.storageManager.setLocalDatabaseStoragePolicy({ephemeral: ephemeral});
      await this.syncManager.sync();
    }
    return result.response;
  }

  async signIn({url, email, password, strict, ephemeral, extraParams}) {
    this.notifyEvent(APPLICATION_EVENT_WILL_SIGN_IN);

    const result = await this.authManager.signIn({
      url, email, password, strict, ephemeral, extraParams
    });

    if(!result.error) {
      await this.keyManager.setRootKey({key: result.rootKey, keyParams: result.keyParams});
      this.notifyEvent(APPLICATION_EVENT_DID_SIGN_IN);
    }

    return result.response;
  }

  async changePassword({email, currentPassword, currentKeyParams, newPassword}) {
    const result = await this.authManager.changePassword({
      url: await this.syncManager.getServerURL(),
      email, currentPassword, currentKeyParams, newPassword
    });

    if(!result.error) {
      await this.keyManager.setRootKey({key: result.rootKey, keyParams: result.keyParams});
      await this.keyManager.createNewItemsKey();
      await this.syncManager.sync();
    }

    return result.response;
  }

  async signOut({dontClearData} = {}) {
    await this.syncManager.handleSignOut();
    await this.modelManager.handleSignOut();
    await this.authManager.signOut();
    await this.keyManager.deleteRootKey();

    if(!dontClearData) {
      await this.storageManager.clearAllData();
    }

    this.notifyEvent(APPLICATION_EVENT_DID_SIGN_OUT);
  }

  createAlertManager() {
    if(this.shouldSkipClass(SNAlertManager)) {
      return;
    }
    this.alertManager = new (this.getClass(SNAlertManager))()
  }

  createAuthManager() {
    this.authManager = new (this.getClass(SNAuthManager))({
      storageManager: this.storageManager,
      httpManager: this.httpManager,
      alertManager: this.alertManager,
      protocolManager: this.protocolManager,
      timeout: this.timeout
    })
  }

  createComponentManager() {
    if(this.shouldSkipClass(SNComponentManager)) {
      return;
    }
    throw 'SNApplication.createComponentManager must be overriden';
  }

  createDatabaseManager() {
    this.databaseManager = new (this.getClass(SNDatabaseManager))({
      namespace: this.namespace
    });
  }

  createHttpManager() {
    this.httpManager = new (this.getClass(SNHttpManager))(
      this.timeout
    );
  }

  createKeyManager() {
    this.keyManager = new (this.getClass(SNKeyManager))({
      modelManager: this.modelManager,
      storageManager: this.storageManager,
      protocolManager: this.protocolManager
    });
  }

  createMigrationManager() {
    this.migrationManager = new (this.getClass(SNMigrationManager))({
      modelManager: this.modelManager,
      storageManager: this.storageManager,
      authManager: this.authManager,
      syncManager: this.syncManager
    });
  }

  createModelManager() {
    this.modelManager = new (this.getClass(SNModelManager))(
      this.timeout
    );
  }

  createSingletonManager() {
    this.singletonManager = new (this.getClass(SNSingletonManager))({
      modelManager: this.modelManager,
      syncManager: this.syncManager
    });
  }

  createStorageManager() {
    this.storageManager = new (this.getClass(SNStorageManager))({
      protocolManager: this.protocolManager,
      databaseManager: this.databaseManager,
      namespace: this.namespace
    });
  }

  createProtocolManager() {
    this.protocolManager = new (this.getClass(SNProtocolManager))({
      modelManager: this.modelManager
    });
  }

  createSyncManager() {
    this.syncManager = new (this.getClass(SNSyncManager))({
      modelManager: this.modelManager,
      storageManager: this.storageManager,
      authManager: this.authManager,
      protocolManager: this.protocolManager,
      httpManager: this.httpManager,
      timeout: this.timeout,
      interval: this.interval
    });
  }

  shouldSkipClass(classCandidate) {
    return this.skipClasses && this.skipClasses.includes(classCandidate);
  }

  getClass(base) {
    const swapClass = this.swapClasses && this.swapClasses.find((candidate) => candidate.swap === base);
    if(swapClass) {
      return swapClass.with;
    } else {
      return base;
    }
  }

}