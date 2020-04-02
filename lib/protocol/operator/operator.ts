import { CreateItemFromPayload } from '@Models/generator';
import { SNRootKey } from './../root_key';
import { SNRootKeyParams } from './../key_params';
import { PurePayload } from './../payloads/pure_payload';
import { SNItemsKey } from '@Models/app/items_key';
import { PayloadFormat } from '@Payloads/formats';
import {
  CreateEncryptionParameters,
  CopyEncryptionParameters,
  CreateMaxPayloadFromAnyObject
} from '@Payloads/generator';
import { ProtocolVersion } from '@Protocol/versions';
import { base64Encode, base64Decode, SNPureCrypto } from 'sncrypto';
import { ContentType } from '@Root/lib/models';

export type RootKeyResponse = {
  key: SNRootKey,
  keyParams: SNRootKeyParams
}

export type ItemsKeyContent = {
  itemsKey: string,
  dataAuthenticationKey?: string,
  version: ProtocolVersion
}

/**w
 * An operator is responsible for performing crypto operations, such as generating keys
 * and encrypting/decrypting payloads. Operators interact directly with the 'sncrypto' lib
 * to directly access cryptographic primitives.
 * Each operator is versioned according to the protocol version. Functions that are common
 * across all versions appear in this generic parent class.
 */
export abstract class SNProtocolOperator {

  protected readonly crypto: SNPureCrypto

  constructor(crypto: SNPureCrypto) {
    this.crypto = crypto;
  }

  /**
   * Computes a root key given a password and previous keyParams
   * @param password - Plain string representing raw user password
   */
  public abstract async computeRootKey(password: string, keyParams: SNRootKeyParams) : Promise<SNRootKey>;

  /**
   * Creates a new root key given an identifier and a user password
   * @param identifier - Plain string representing a unique identifier
   *    for the user
   * @param password - Plain string representing raw user password
   */
  public abstract async createRootKey(identifier: string, password: string): Promise<RootKeyResponse>;

  protected abstract async generateNewItemsKeyContent(): Promise<ItemsKeyContent>;

  protected async firstHalfOfKey(key: string) {
    return key.substring(0, key.length / 2);
  }

  protected async secondHalfOfKey(key: string) {
    return key.substring(key.length / 2, key.length);
  }

  protected splitKey(
    key: string,
    parts: number
  ) {
    const outputLength = key.length;
    const partLength = outputLength / parts;
    const partitions = [];
    for (let i = 0; i < parts; i++) {
      const partition = key.slice(
        partLength * i,
        partLength * (i + 1)
      );
      partitions.push(partition);
    }
    return partitions;
  }

  /**
   * Creates a new random SNItemsKey to use for item encryption.
   * The consumer must save/sync this item.
   */
  public async createItemsKey() {
    const content = await this.generateNewItemsKeyContent();
    const payload = CreateMaxPayloadFromAnyObject(
      {
        content_type: ContentType.ItemsKey,
        content: content
      }
    );

    const itemsKey = CreateItemFromPayload(payload);
    await itemsKey.initUUID();
    return itemsKey;
  }

  /**
  * Converts a bare payload into an encrypted one in the desired format.
  * @param payload - The non-encrypted payload object to encrypt
  * @param key - The key to use to encrypt the payload. Can be either
  *  a RootKey (when encrypting payloads that require root key encryption, such as encrypting
  * items keys), or an ItemsKey (if encrypted regular items)
  * @param format - The desired result format
  */
  public async generateEncryptedParameters(
    payload: PurePayload,
    format: PayloadFormat,
    key?: SNItemsKey | SNRootKey,
  ) {
    if (format === PayloadFormat.DecryptedBareObject) {
      return CreateEncryptionParameters(
        {
          content: payload.content
        }
      );
    } else if (format === PayloadFormat.DecryptedBase64String) {
      const jsonString = JSON.stringify(payload.content);
      const base64String = await base64Encode(jsonString);
      const content = ProtocolVersion.V000Base64Decrypted + base64String;
      return CreateEncryptionParameters(
        {
          content: content
        }
      );
    } else {
      throw `Must override generateEncryptedParameters to handle format ${format}.`;
    }
  }

  /**
  * Converts encrypted parameters (a subset of a Payload) into decrypted counterpart.
  * @param encryptedParameters - The encrypted payload object to decrypt
  * @param key - The key to use to decrypt the payload. Can be either
  *  a RootKey (when encrypting payloads that require root key encryption, such as encrypting
  * items keys), or an ItemsKey (if encrypted regular items)
  */
  public async generateDecryptedParameters(
    encryptedParameters: PurePayload,
    key?: SNItemsKey | SNRootKey,
  ) {
    const format = encryptedParameters.format;
    if (format === PayloadFormat.DecryptedBareObject) {
      /** No decryption required */
      return encryptedParameters;
    }
    else if (format === PayloadFormat.DecryptedBase64String) {
      const contentString = encryptedParameters.contentString.substring(
        ProtocolVersion.VersionLength,
        encryptedParameters.contentString.length
      );
      let decodedContent;
      try {
        const jsonString = await base64Decode(contentString);
        decodedContent = JSON.parse(jsonString);
      } catch (e) {
        decodedContent = encryptedParameters.content;
      }
      return CopyEncryptionParameters(
        encryptedParameters,
        {
          content: decodedContent
        }
      );
    } else {
      throw `Must override generateDecryptedParameters to handle format ${format}.`;
    }
  }
}
