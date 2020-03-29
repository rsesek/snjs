import { EncryptionIntents } from '@Protocol/intents';
import { SNRootKey } from '@Protocol/root_key';
import { PurePayload } from '@Payloads/pure_payload';
import { PureService } from '@Lib/services/pure_service';
import { ApplicationStages, RawStorageKeys, namespacedKey } from '@Lib/index';
import { CreateMaxPayloadFromAnyObject } from '@Payloads/index';
import { ContentTypes } from '@Models/content_types';
import { isNullOrUndefined, Copy } from '@Lib/utils';
import { Uuid } from '@Lib/uuid';
import { SNProtocolService } from './protocol_service';
import { DeviceInterface } from '../device_interface';

export enum StoragePersistencePolicies {
  Default = 1,
  Ephemeral = 2
};

export enum StorageEncryptionPolicies {
  Default = 1,
  Disabled = 2,
};

export enum StorageValueModes {
  /** Stored inside wrapped encrpyed storage object */
  Default = 1,
  /** Stored outside storage object, unencrypted */
  Nonwrapped = 2
};

export enum ValueModesKeys {
  /* Is encrypted */
  Wrapped = 'wrapped',
  /* Is decrypted */
  Unwrapped = 'unwrapped',
  /* Lives outside of wrapped/unwrapped */
  Nonwrapped = 'nonwrapped',
};

type ValuesObjectRecord = Record<string, any>

type ValuesObject = {
  [ValueModesKeys.Wrapped]: ValuesObjectRecord
  [ValueModesKeys.Unwrapped]?: ValuesObjectRecord
  [ValueModesKeys.Nonwrapped]: ValuesObjectRecord
}

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

  private protocolService?: SNProtocolService
  private deviceInterface?: DeviceInterface
  private namespace: string
  /** Wait until application has been unlocked before trying to persist */
  private storagePersistable = false
  private persistencePolicy!: StoragePersistencePolicies
  private encryptionPolicy!: StorageEncryptionPolicies

  private values!: ValuesObject

  constructor(
    protocolService: SNProtocolService,
    deviceInterface: DeviceInterface,
    namespace: string
  ) {
    super();
    this.deviceInterface = deviceInterface;
    this.protocolService = protocolService;
    this.namespace = namespace;
    this.setPersistencePolicy(StoragePersistencePolicies.Default);
    this.setEncryptionPolicy(StorageEncryptionPolicies.Default);
  }

  public deinit() {
    this.deviceInterface = undefined;
    this.protocolService = undefined;
    super.deinit();
  }

  async handleApplicationStage(stage: ApplicationStages) {
    await super.handleApplicationStage(stage);
    if (stage === ApplicationStages.Launched_10) {
      this.storagePersistable = true;
    }
  }

  public async setPersistencePolicy(persistencePolicy: StoragePersistencePolicies) {
    this.persistencePolicy = persistencePolicy;
    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      await this.deviceInterface!.removeAllRawStorageValues();
      await this.clearAllPayloads();
    }
  }

  public async setEncryptionPolicy(encryptionPolicy: StorageEncryptionPolicies) {
    this.encryptionPolicy = encryptionPolicy;
  }

  public isEphemeralSession() {
    return this.persistencePolicy === StoragePersistencePolicies.Ephemeral;
  }

  public async initializeFromDisk() {
    const value = await this.deviceInterface!.getRawStorageValue(
      this.getPersistenceKey()
    );
    const payload = value ? JSON.parse(value) : null;
    this.setInitialValues(payload);
  }

  private async persistAsValueToDisk(value: ValuesObject) {
    await this.deviceInterface!.setRawStorageValue(
      this.getPersistenceKey(),
      JSON.stringify(value)
    );
  }

  /**
   * Called by platforms with the value they load from disk,
   * after they handle initializeFromDisk
   */
  private setInitialValues(values?: ValuesObject) {
    if (!values) {
      values = this.defaultValuesObject();
    }
    if (!values![ValueModesKeys.Unwrapped]) {
      values![ValueModesKeys.Unwrapped] = {};
    }
    this.values = values!;
  }

  public isStorageWrapped() {
    const wrappedValue = this.values[ValueModesKeys.Wrapped];
    return !isNullOrUndefined(wrappedValue) && Object.keys(wrappedValue).length > 0;
  }

  public async canDecryptWithKey(key: SNRootKey) {
    const wrappedValue = this.values[ValueModesKeys.Wrapped];
    const decryptedPayload = await this.decryptWrappedValue(
      wrappedValue,
      key,
    );
    return !decryptedPayload.errorDecrypting;
  }

  private async decryptWrappedValue(wrappedValue: any, key?: SNRootKey) {
    /**
    * The read content type doesn't matter, so long as we know it responds
    * to content type. This allows a more seamless transition when both web
    * and mobile used different content types for encrypted storage.
    */
    if (!wrappedValue.content_type) {
      throw 'Attempting to decrypt nonexistent wrapped value';
    }

    const payload = CreateMaxPayloadFromAnyObject(
      wrappedValue,
      undefined,
      undefined,
      {
        content_type: ContentTypes.EncryptedStorage
      }
    );

    const decryptedPayload = await this.protocolService!.payloadByDecryptingPayload({
      payload: payload,
      key: key
    });
    return decryptedPayload;
  }

  public async decryptStorage() {
    const wrappedValue = this.values[ValueModesKeys.Wrapped];
    const decryptedPayload = await this.decryptWrappedValue(wrappedValue);
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
  private async generatePersistenceValue() {
    const rawContent = Object.assign(
      {},
      this.values
    );
    const valuesToWrap = rawContent[ValueModesKeys.Unwrapped];
    const payload = CreateMaxPayloadFromAnyObject(
      {
        uuid: await Uuid.GenerateUuid(),
        content: valuesToWrap,
        content_type: ContentTypes.EncryptedStorage
      }
    );
    const encryptedPayload = await this.protocolService!.payloadByEncryptingPayload({
      payload: payload,
      intent: EncryptionIntents.LocalStoragePreferEncrypted
    });
    rawContent[ValueModesKeys.Wrapped] = encryptedPayload;
    rawContent[ValueModesKeys.Unwrapped] = undefined;
    return rawContent;
  }

  private async repersistToDisk() {
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

  public async setValue(key: string, value: any, mode = StorageValueModes.Default) {
    if (!this.values) {
      throw `Attempting to set storage key ${key} before loading local storage.`;
    }
    this.values[this.domainKeyForMode(mode)]![key] = value;
    return this.repersistToDisk();
  }

  public async getValue(key: string, mode = StorageValueModes.Default) {
    if (!this.values) {
      throw `Attempting to get storage key ${key} before loading local storage.`;
    }
    if (!this.values[this.domainKeyForMode(mode)]) {
      throw `Storage domain mode not available ${mode} for key ${key}`;
    }
    return this.values[this.domainKeyForMode(mode)]![key];
  }

  public async removeValue(key: string, mode = StorageValueModes.Default) {
    if (!this.values) {
      throw `Attempting to remove storage key ${key} before loading local storage.`;
    }
    delete this.values[this.domainKeyForMode(mode)]![key];
    return this.repersistToDisk();
  }

  /**
   * Default persistence key. Platforms can override as needed.
   */
  private getPersistenceKey() {
    return namespacedKey(this.namespace, RawStorageKeys.StorageObject);
  }

  private defaultValuesObject(
    wrapped?: ValuesObjectRecord,
    unwrapped?: ValuesObjectRecord,
    nonwrapped?: ValuesObjectRecord
  ) {
    return SNStorageService.defaultValuesObject(
      wrapped,
      unwrapped,
      nonwrapped
    );
  }

  public static defaultValuesObject(
    wrapped: ValuesObjectRecord = {},
    unwrapped: ValuesObjectRecord = {},
    nonwrapped: ValuesObjectRecord = {}
  ) {
    return {
      [ValueModesKeys.Wrapped]: wrapped,
      [ValueModesKeys.Unwrapped]: unwrapped,
      [ValueModesKeys.Nonwrapped]: nonwrapped
    };
  }

  private domainKeyForMode(mode: StorageValueModes) {
    if (mode === StorageValueModes.Default) {
      return ValueModesKeys.Unwrapped;
    } else if (mode === StorageValueModes.Nonwrapped) {
      return ValueModesKeys.Nonwrapped;
    } else {
      throw 'Invalid mode';
    }
  }

  /**
   * Clears simple values from storage only. Does not affect payloads.
   */
  async clearValues() {
    this.setInitialValues();
    await this.repersistToDisk();
  }

  public async getAllRawPayloads() {
    return this.deviceInterface!.getAllRawDatabasePayloads();
  }

  public async savePayload(payload: PurePayload) {
    return this.savePayloads([payload]);
  }

  public async savePayloads(decryptedPayloads: PurePayload[]) {
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
        const encrypted = await this.protocolService!.payloadByEncryptingPayload({
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
    await this.deviceInterface!.saveRawDatabasePayloads(nondeleted);
  }

  public async deletePayloads(payloads: PurePayload[]) {
    for (const payload of payloads) {
      await this.deletePayloadWithId(payload.uuid);
    }
  }

  public async deletePayloadWithId(id: string) {
    return this.deviceInterface!.removeRawDatabasePayloadWithId(id);
  }

  public async clearAllPayloads() {
    return this.deviceInterface!.removeAllRawDatabasePayloads();
  }

  public async clearAllData() {
    return Promise.all([
      this.clearValues(),
      this.clearAllPayloads()
    ]);
  }
}