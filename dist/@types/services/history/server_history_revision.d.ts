import { BaseHistory, HistoryContent } from './base_history';
import { HttpResponse } from '../api/http_service';
import { SNProtocolService } from '../protocol_service';
export declare class ServerHistoryRevision extends BaseHistory {
    constructor(content?: HistoryContent);
    static FromResponse(protocolService: SNProtocolService, itemUuid: string, response?: HttpResponse): Promise<ServerHistoryRevision>;
}
