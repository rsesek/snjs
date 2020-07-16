import { History, HistoryContent } from './history';
import { HttpResponse } from '../api/http_service';
import { SNProtocolService } from '../protocol_service';
export declare class HistoryServer extends History {
    constructor(content?: HistoryContent);
    static FromResponse(protocolService: SNProtocolService, itemUuid: string, response?: HttpResponse): Promise<HistoryServer>;
}
