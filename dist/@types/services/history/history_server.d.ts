import { History, HistoryContent } from './history';
import { HttpResponse } from '../api/http_service';
export declare class HistoryServer extends History {
    constructor(content?: HistoryContent);
    static FromResponse(response?: HttpResponse): HistoryServer;
}
