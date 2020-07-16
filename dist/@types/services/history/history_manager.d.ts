import { SNStorageService } from '../storage_service';
import { ItemManager } from '../item_manager';
import { SNItem } from '../../models/core/item';
import { ContentType } from '../../models/content_types';
import { PureService } from '../pure_service';
import { PayloadSource } from '../../protocol/payloads/sources';
import { SNApiService } from '../api/api_service';
import { PurePayload } from '../../protocol/payloads';
import { SNProtocolService } from '../protocol_service';
/**
 * The history manager is responsible for transient 'session history',
 * which include keeping track of changes made in the current application session.
 * These change logs (unless otherwise configured) are ephemeral and do not persist
 * past application restart.
 * History manager is also responsible for remote server history.
 */
export declare class SNHistoryManager extends PureService {
    private itemManager?;
    private storageService?;
    private apiService?;
    private protocolService?;
    private contentTypes;
    private timeout;
    private historySession?;
    private historyServer?;
    private removeChangeObserver;
    private persistable;
    autoOptimize: boolean;
    private saveTimeout;
    constructor(itemManager: ItemManager, storageService: SNStorageService, apiService: SNApiService, protocolService: SNProtocolService, contentTypes: ContentType[], timeout: any);
    deinit(): void;
    initializeFromDisk(): Promise<void>;
    addChangeObserver(): void;
    isDiskEnabled(): boolean;
    isAutoOptimizeEnabled(): boolean;
    saveToDisk(): Promise<void>;
    setSessionItemRevisionThreshold(threshold: number): void;
    addEntryForPayload(payload: PurePayload): any;
    addHistoryEntryForItem(item: SNItem, source: PayloadSource): Promise<void>;
    sessionHistoryForItem(item: SNItem): import("./item_history").ItemHistory;
    fetchHistoryFromServer(item: SNItem): Promise<void>;
    serverHistoryForItem(item: SNItem): Promise<import("./item_history").ItemHistory>;
    clearHistoryForItem(item: SNItem): Promise<void>;
    clearAllHistory(): Promise<void>;
    toggleDiskSaving(): Promise<void>;
    toggleAutoOptimize(): Promise<void>;
}
