/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import * as Factory from '../lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe('offline syncing', () => {
  const BASE_ITEM_COUNT = 1; /** Default items key */

  beforeEach(async function() {
    this.expectedItemCount = BASE_ITEM_COUNT;
    this.application = await Factory.createInitAppWithRandNamespace();
  });

  afterEach(async function() {
    expect(this.application.syncService.isOutOfSync()).to.equal(false);
    this.application.deinit();
  });

  before(async function() {
    localStorage.clear();
  });

  after(async function() {
    localStorage.clear();
  });

  it('should sync item with no passcode', async function() {
    const note = await Factory.createMappedNote(this.application);
    expect(this.application.modelManager.getDirtyItems().length).to.equal(1);
    const rawPayloads1 = await this.application.storageService.getAllRawPayloads();
    expect(rawPayloads1.length).to.equal(this.expectedItemCount);

    await this.application.syncService.sync();
    /** In rare cases a sync can complete so fast that the dates are equal; this is ok. */
    expect(note.lastSyncEnd).to.be.at.least(note.lastSyncBegan);
    this.expectedItemCount++;

    expect(this.application.modelManager.getDirtyItems().length).to.equal(0);
    const rawPayloads2 = await this.application.storageService.getAllRawPayloads();
    expect(rawPayloads2.length).to.equal(this.expectedItemCount);

    const itemsKeyRP = (await Factory.getStoragePayloadsOfType(
      this.application, ContentType.ItemsKey
    ))[0];
    const noteRP = (await Factory.getStoragePayloadsOfType(
      this.application, ContentType.Note
    ))[0];

    /** Encrypts with default items key */
    expect(typeof noteRP.content).to.equal('string');
    /** Not encrypted as no passcode/root key */
    expect(typeof itemsKeyRP.content).to.equal('object');
  });

  it('should sync item encrypted with passcode', async function() {
    await this.application.setPasscode('foobar');
    await Factory.createMappedNote(this.application);
    expect(this.application.modelManager.getDirtyItems().length).to.equal(1);
    const rawPayloads1 = await this.application.storageService.getAllRawPayloads();
    expect(rawPayloads1.length).to.equal(this.expectedItemCount);

    await this.application.syncService.sync();
    this.expectedItemCount++;

    expect(this.application.modelManager.getDirtyItems().length).to.equal(0);
    const rawPayloads2 = await this.application.storageService.getAllRawPayloads();
    expect(rawPayloads2.length).to.equal(this.expectedItemCount);

    const payload = rawPayloads2[0];
    expect(typeof payload.content).to.equal('string');
    expect(payload.content.startsWith(this.application.protocolService.getLatestVersion())).to.equal(true);
  });

  it('signing out while offline should succeed', async function () {
    await Factory.createMappedNote(this.application);
    this.expectedItemCount++;
    await this.application.syncService.sync();
    this.application = await Factory.signOutApplicationAndReturnNew(this.application);
    expect(this.application.noAccount()).to.equal(true);
    expect(this.application.getUser()).to.not.be.ok;
  });
});