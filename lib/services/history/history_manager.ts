import { SNStorageService } from '@Services/storage_service';
import { ItemManager } from '@Services/item_manager';
import { CreateSourcedPayloadFromObject } from '@Payloads/generator';
import { SNItem } from '@Models/core/item';
import { ContentType } from '@Models/content_types';
import { PureService } from '@Lib/services/pure_service';
import { HistorySession } from '@Services/history/history_session';
import { HistoryServer } from '@Services/history/history_server';
import { PayloadSource } from '@Payloads/sources';
import { StorageKey } from '@Lib/storage_keys';
import { isNullOrUndefined, concatArrays } from '@Lib/utils';
import { SNApiService } from '@Services/api/api_service';
import { PurePayload } from '@Lib/protocol/payloads';

const PERSIST_TIMEOUT = 2000;

/**
 * The history manager is responsible for transient 'session history',
 * which include keeping track of changes made in the current application session.
 * These change logs (unless otherwise configured) are ephemeral and do not persist
 * past application restart.
 * History manager is also responsible for remote server history.
 */
export class SNHistoryManager extends PureService {

  private itemManager?: ItemManager
  private storageService?: SNStorageService
  private apiService?: SNApiService
  private contentTypes: ContentType[] = []
  private timeout: any
  private historySession?: HistorySession
  private historyServer?: HistoryServer
  private removeChangeObserver: any
  private persistable = false
  public autoOptimize = false
  private saveTimeout: any

  constructor(
    itemManager: ItemManager,
    storageService: SNStorageService,
    apiService: SNApiService,
    contentTypes: ContentType[],
    timeout: any
  ) {
    super();
    this.itemManager = itemManager;
    this.storageService = storageService;
    this.apiService = apiService;
    this.contentTypes = contentTypes;
    this.timeout = timeout;
  }

  public deinit() {
    this.itemManager = undefined;
    this.storageService = undefined;
    this.apiService = undefined;
    this.contentTypes.length = 0;
    this.historySession = undefined;
    this.timeout = null;
    if (this.removeChangeObserver) {
      this.removeChangeObserver();
      this.removeChangeObserver = null;
    }
    super.deinit();
  }

  async initializeFromDisk() {
    this.persistable = await this.storageService!.getValue(
      StorageKey.SessionHistoryPersistable
    );
    this.historySession = await this.storageService!.getValue(
      StorageKey.SessionHistoryRevisions
    ).then((historyValue) => {
      return HistorySession.FromJson(historyValue);
    });
    const autoOptimize = await this.storageService!.getValue(
      StorageKey.SessionHistoryOptimize
    );
    if (isNullOrUndefined(autoOptimize)) {
      /** Default to true */
      this.autoOptimize = true;
    } else {
      this.autoOptimize = autoOptimize;
    }
    this.addChangeObserver();
  }

  addChangeObserver() {
    this.removeChangeObserver = this.itemManager!.addObserver(
      this.contentTypes,
      (changed, inserted, discarded, source) => {
        const items = concatArrays(changed, inserted, discarded) as SNItem[];
        if (source === PayloadSource.LocalChanged) {
          return;
        }
        for (const item of items) {
          try {
            if (!item.deleted && !item.errorDecrypting) {
              this.addHistoryEntryForItem(item, PayloadSource.SessionHistory);
            }
          } catch (e) {
            console.error('Unable to add item history entry:', e);
          }
        }
      }
    )
  }

  isDiskEnabled() {
    return this.persistable;
  }

  isAutoOptimizeEnabled() {
    return this.autoOptimize;
  }

  async saveToDisk() {
    if (!this.persistable) {
      return;
    }
    this.storageService!.setValue(
      StorageKey.SessionHistoryRevisions,
      this.historySession
    );
  }

  setSessionItemRevisionThreshold(threshold: number) {
    this.historySession!.setItemRevisionThreshold(threshold);
  }

  addEntryForPayload(payload: PurePayload) {
    switch (payload.source) {
      case PayloadSource.ServerHistory:
        return this.historyServer!.addEntryForPayload(payload);
      case PayloadSource.SessionHistory:
        return this.historySession!.addEntryForPayload(payload);
    }
  }

  async addHistoryEntryForItem(item: SNItem, source: PayloadSource) {
    const payload = CreateSourcedPayloadFromObject(item, source)
    const entry = this.addEntryForPayload(payload);
    if (source === PayloadSource.ServerHistory) {
      return;
    }
    if (this.autoOptimize) {
      this.historySession!.optimizeHistoryForItem(item.uuid);
    }
    if (entry && this.persistable) {
      /** Debounce, clear existing timeout */
      if (this.saveTimeout) {
        if (this.timeout.hasOwnProperty('cancel')) {
          this.timeout.cancel(this.saveTimeout);
        } else {
          clearTimeout(this.saveTimeout);
        }
      };
      this.saveTimeout = this.timeout(() => {
        this.saveToDisk();
      }, PERSIST_TIMEOUT);
    }
  }

  sessionHistoryForItem(item: SNItem) {
    return this.historySession!.historyForItem(item.uuid);
  }

  async fetchHistoryFromServer(item: SNItem) {
    const itemRevisionsResponse = await this.apiService!.getItemRevisions(item.uuid);
    this.historyServer = HistoryServer.FromResponse(itemRevisionsResponse);
  }

  async serverHistoryForItem(item: SNItem) {
    await this.fetchHistoryFromServer(item);
    return this.historyServer!.historyForItem(item.uuid);
  }

  async clearHistoryForItem(item: SNItem) {
    this.historySession!.clearItemHistory(item);
    return this.saveToDisk();
  }

  async clearAllHistory() {
    this.historySession!.clearAllHistory();
    return this.storageService!.removeValue(
      StorageKey.SessionHistoryRevisions
    );
  }

  async toggleDiskSaving() {
    this.persistable = !this.persistable;
    if (this.persistable) {
      this.storageService!.setValue(
        StorageKey.SessionHistoryPersistable,
        true
      );
      this.saveToDisk();
    } else {
      this.storageService!.setValue(
        StorageKey.SessionHistoryPersistable,
        false
      );
      return this.storageService!.removeValue(
        StorageKey.SessionHistoryRevisions
      );
    }
  }

  async toggleAutoOptimize() {
    this.autoOptimize = !this.autoOptimize;
    if (this.autoOptimize) {
      this.storageService!.setValue(
        StorageKey.SessionHistoryOptimize,
        true
      );
    } else {
      this.storageService!.setValue(
        StorageKey.SessionHistoryOptimize,
        false
      );
    }
  }
}
