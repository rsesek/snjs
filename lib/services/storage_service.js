import { PureService } from '@Lib/services/pure_service';
import {
  EncryptionIntents
} from '@Protocol';
import { ApplicationStages, StorageKeys, namespacedKey } from '@Lib';
import { CreateMaxPayloadFromAnyObject } from '@Payloads';
import { ContentTypes } from '@Models/content_types';
import { isNullOrUndefined, Copy } from '@Lib/utils';
import { Uuid } from '@Lib/uuid';

/** @access public */
export const StoragePersistencePolicies = {
  Default: 1,
  Ephemeral: 2
};
/** @access public */
export const StorageEncryptionPolicies = {
  Default: 1,
  Disabled: 2,
};
/** @access public */
export const StorageValueModes = {
  /** Stored inside wrapped encrpyed storage object */
  Default: 1,
  /** Stored outside storage object, unencrypted */
  Nonwrapped: 2
};
/** @access public */
export const ValueModesKeys = {
  /* Is encrypted */
  Wrapped: 'wrapped',
  /* Is decrypted */
  Unwrapped: 'unwrapped',
  /* Lives outside of wrapped/unwrapped */
  Nonwrapped: 'nonwrapped',
};

/**
 * The storage service is responsible for persistence of both simple key-values, and payload
 * storage. It does so by relying on deviceInterface to save and retrieve raw values and payloads.
 * For simple key/values, items are grouped together in an in-memory hash, and persisted to disk
 * as a single object (encrypted, when possible). It handles persisting payloads in the local 
 * database by encrypting the payloads when possible.
 * The storage service also exposes methods that allow the application to initially
 * decrypt the persisted key/values, and also a method to determine whether a particular
 * key can decrypt wrapped storage.
 */
export class SNStorageService extends PureService {
  constructor({ protocolService, deviceInterface, namespace }) {
    super();
    this.deviceInterface = deviceInterface;
    this.protocolService = protocolService;
    this.namespace = namespace;
    this.setPersistencePolicy(StoragePersistencePolicies.Default);
    this.setEncryptionPolicy(StorageEncryptionPolicies.Default);
    /** Wait until application has been unlocked before trying to persist */
    this.storagePersistable = false;
  }

  /**
   * @access protected
   */
  async handleApplicationStage(stage) {
    await super.handleApplicationStage(stage);
    if (stage === ApplicationStages.Launched_10) {
      this.storagePersistable = true;
    }
  }

  async setPersistencePolicy(persistencePolicy) {
    this.persistencePolicy = persistencePolicy;
    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      await this.deviceInterface.removeAllRawStorageValues();
      await this.clearAllPayloads();
    }
  }

  async setEncryptionPolicy(encryptionPolicy) {
    this.encryptionPolicy = encryptionPolicy;
  }

  isEphemeralSession() {
    return this.persistencePolicy === StoragePersistencePolicies.Ephemeral;
  }

  async initializeFromDisk() {
    const value = await this.deviceInterface.getRawStorageValue(
      this.getPersistenceKey()
    );
    const payload = value ? JSON.parse(value) : null;
    this.setInitialValues(payload);
  }

  async persistAsValueToDisk(payload) {
    await this.deviceInterface.setRawStorageValue(
      this.getPersistenceKey(),
      JSON.stringify(payload)
    );
  }

  /**
   * @access protected
   * Called by platforms with the value they load from disk,
   * after they handle initializeFromDisk
   */
  setInitialValues(values) {
    if (!values) {
      values = this.defaultValuesObject();
    }
    if(!values[ValueModesKeys.Unwrapped]) {
      values[ValueModesKeys.Unwrapped] = {};
    }
    this.values = values;
  }

  /** @access public */
  isStorageWrapped() {
    const wrappedValue = this.values[ValueModesKeys.Wrapped];
    return !isNullOrUndefined(wrappedValue) && Object.keys(wrappedValue).length > 0;
  }

  /** @access public */
  async canDecryptWithKey(key) {
    const wrappedValue = this.values[ValueModesKeys.Wrapped];
    const decryptedPayload = await this.decryptWrappedValue({
      wrappedValue: wrappedValue,
      key: key,
      throws: false
    });
    return !decryptedPayload.errorDecrypting;
  }

  /** @access private */
  async decryptWrappedValue({ wrappedValue, key }) {
    /**
    * The read content type doesn't matter, so long as we know it responds
    * to content type. This allows a more seamless transition when both web
    * and mobile used different content types for encrypted storage.
    */
    if (!wrappedValue.content_type) {
      throw 'Attempting to decrypt nonexistent wrapped value';
    }

    const payload = CreateMaxPayloadFromAnyObject({
      object: wrappedValue,
      override: {
        content_type: ContentTypes.EncryptedStorage
      }
    });

    const decryptedPayload = await this.protocolService
      .payloadByDecryptingPayload({
        payload: payload,
        key: key
      });

    return decryptedPayload;
  }

  /** @access public */
  async decryptStorage() {
    const wrappedValue = this.values[ValueModesKeys.Wrapped];
    const decryptedPayload = await this.decryptWrappedValue({
      wrappedValue: wrappedValue
    });
    if (decryptedPayload.errorDecrypting) {
      throw 'Unable to decrypt storage.';
    }
    this.values[ValueModesKeys.Unwrapped] = Copy(decryptedPayload.content);
    delete this.values[ValueModesKeys.Wrapped];
  }

  /**
   * Generates a payload that can be persisted to disk,
   * either as a plain object, or an encrypted item.
   */
  async generatePersistenceValue() {
    const rawContent = Object.assign(
      {},
      this.values
    );
    const valuesToWrap = rawContent[ValueModesKeys.Unwrapped];
    const payload = CreateMaxPayloadFromAnyObject({
      object: {
        uuid: await Uuid.GenerateUuid(),
        content: valuesToWrap,
        content_type: ContentTypes.EncryptedStorage
      }
    });
    const encryptedPayload = await this.protocolService.payloadByEncryptingPayload({
      payload: payload,
      intent: EncryptionIntents.LocalStoragePreferEncrypted
    });
    rawContent[ValueModesKeys.Wrapped] = encryptedPayload;
    rawContent[ValueModesKeys.Unwrapped] = null;
    return rawContent;
  }

  async repersistToDisk() {
    if (!this.storagePersistable) {
      return;
    }
    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      return;
    }
    const value = await this.generatePersistenceValue();
    /** Save the persisted value so we have access to it in memory (for unit tests afawk) */
    this.values[ValueModesKeys.Wrapped] = value[ValueModesKeys.Wrapped];
    return this.persistAsValueToDisk(value);
  }

  async setValue(key, value, mode = StorageValueModes.Default) {
    if (!this.values) {
      throw `Attempting to set storage key ${key} before loading local storage.`;
    }
    this.values[this.domainKeyForMode(mode)][key] = value;
    return this.repersistToDisk();
  }

  async getValue(key, mode = StorageValueModes.Default) {
    if (!this.values) {
      throw `Attempting to get storage key ${key} before loading local storage.`;
    }
    if (!this.values[this.domainKeyForMode(mode)]) {
      throw `Storage domain mode not available ${mode} for key ${key}`;
    }
    return this.values[this.domainKeyForMode(mode)][key];
  }

  async removeValue(key, mode = StorageValueModes.Default) {
    if (!this.values) {
      throw `Attempting to remove storage key ${key} before loading local storage.`;
    }
    delete this.values[this.domainKeyForMode(mode)][key];
    return this.repersistToDisk();
  }

  /**
   * Default persistence key. Platforms can override as needed.
   */
  getPersistenceKey() {
    return namespacedKey(this.namespace, StorageKeys.StorageObject);
  }

  defaultValuesObject({ wrapped, unwrapped, nonwrapped } = {}) {
    return this.constructor.defaultValuesObject({ wrapped, unwrapped, nonwrapped });
  }

  static defaultValuesObject({ wrapped = {}, unwrapped = {}, nonwrapped = {} } = {}) {
    return {
      [ValueModesKeys.Wrapped]: wrapped,
      [ValueModesKeys.Unwrapped]: unwrapped,
      [ValueModesKeys.Nonwrapped]: nonwrapped
    };
  }

  /** @access private */
  static domainKeyForMode(mode) {
    if (mode === StorageValueModes.Default) {
      return ValueModesKeys.Unwrapped;
    } else if (mode === StorageValueModes.Nonwrapped) {
      return ValueModesKeys.Nonwrapped;
    } else {
      throw 'Invalid mode';
    }
  }

  /** @access private */
  domainKeyForMode(mode) {
    return this.constructor.domainKeyForMode(mode);
  }

  /**
   * Clears simple values from storage only. Does not affect payloads.
   */
  async clearValues() {
    this.setInitialValues();
    await this.repersistToDisk();
  }

  /** Payload Storage */

  async getAllRawPayloads() {
    return this.deviceInterface.getAllRawDatabasePayloads();
  }

  async savePayload(payload) {
    return this.savePayloads([payload]);
  }

  async savePayloads(decryptedPayloads) {
    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      return;
    }

    const deleted = [];
    const nondeleted = [];
    for (const payload of decryptedPayloads) {
      if (payload.discardable) {
        /** If the payload is deleted and not dirty, remove it from db. */
        deleted.push(payload);
      } else {
        const encrypted = await this.protocolService.payloadByEncryptingPayload({
          payload: payload,
          intent:
            this.encryptionPolicy === StorageEncryptionPolicies.Default
              ? EncryptionIntents.LocalStoragePreferEncrypted
              : EncryptionIntents.LocalStorageDecrypted
        });
        nondeleted.push(encrypted);
      }
    }

    if (deleted.length > 0) {
      await this.deletePayloads(deleted);
    }
    await this.deviceInterface.saveRawDatabasePayloads(nondeleted);
  }

  async deletePayloads(payloads) {
    for (const payload of payloads) {
      await this.deletePayloadWithId(payload.uuid);
    }
  }

  async deletePayloadWithId(id) {
    return this.deviceInterface.removeRawDatabasePayloadWithId(id);
  }

  async clearAllPayloads() {
    return this.deviceInterface.removeAllRawDatabasePayloads();
  }

  async clearAllData() {
    return Promise.all([
      this.clearValues(),
      this.clearAllPayloads()
    ]);
  }
}