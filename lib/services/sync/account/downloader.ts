import { PurePayload } from '@Payloads/pure_payload';
import { ContentTypes } from '@Models/content_types';
import { CreateSourcedPayloadFromObject } from '@Payloads/generator';
import { PayloadSources } from '@Lib/protocol/payloads/sources';
import { SNApiService } from '../../api/api_service';
import { SNProtocolService } from '../../protocol_service';

type Progress = {
  retrievedPayloads: PurePayload[]
  lastSyncToken?: string
  paginationToken?: string
}

export class AccountDownloader {

  private apiService: SNApiService
  private protocolService: SNProtocolService
  private contentType?: ContentTypes
  private customEvent?: string
  private limit?: number
  private progress: Progress

  constructor(
    apiService: SNApiService,
    protocolService: SNProtocolService,
    contentType?: ContentTypes,
    customEvent?: string,
    limit?: number
  ) {
    this.apiService = apiService;
    this.protocolService = protocolService;
    this.contentType = contentType;
    this.customEvent = customEvent;
    this.limit = limit;
    this.progress = { retrievedPayloads: [] };
  }

  /**
   * Executes a sync request with a blank sync token and high download limit. It will download all items,
   * but won't do anything with them other than decrypting and creating respective objects.
   */
  async run() : Promise<PurePayload[]> {
    const response = await this.apiService.sync(
      [],
      this.progress.lastSyncToken!,
      this.progress.paginationToken!,
      this.limit || 500,
      false,
      this.contentType,
      this.customEvent,
    );
    const encryptedPayloads = response.retrieved_items.map((rawPayload: any) => {
      return CreateSourcedPayloadFromObject(
        rawPayload,
        PayloadSources.RemoteRetrieved
      );
    });
    const decryptedPayloads = await this.protocolService.payloadsByDecryptingPayloads(
      encryptedPayloads
    );

    this.progress.retrievedPayloads = this.progress.retrievedPayloads.concat(
      decryptedPayloads
    );
    this.progress.lastSyncToken = response.sync_token;
    this.progress.paginationToken = response.cursor_token;

    if (response.cursor_token) {
      return this.run();
    } else {
      return this.progress.retrievedPayloads;
    }
  }
}
