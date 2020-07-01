/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import * as Factory from '../lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe('importing', () => {
  const BASE_ITEM_COUNT = 1; /** Default items key */

  beforeEach(async function () {
    this.expectedItemCount = BASE_ITEM_COUNT;
    this.application = await Factory.createInitAppWithRandNamespace();
    this.email = Uuid.GenerateUuidSynchronously();
    this.password = Uuid.GenerateUuidSynchronously();
  });

  afterEach(async function () {
    await this.application.deinit();
  });

  it('importing existing data should keep relationships valid', async function () {
    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await this.application.itemManager.emitItemsFromPayloads(
      [notePayload, tagPayload],
      PayloadSource.LocalChanged
    );
    this.expectedItemCount += 2;
    const note = this.application.itemManager.getItems([ContentType.Note])[0];
    const tag = this.application.itemManager.getItems([ContentType.Tag])[0];

    expect(tag.content.references.length).to.equal(1);
    expect(tag.noteCount).to.equal(1);

    expect(note.content.references.length).to.equal(0);
    expect(this.application.itemManager.itemsReferencingItem(note.uuid).length).to.equal(1);

    await this.application.importData(
      {
        items: [notePayload, tagPayload]
      },
      undefined,
      true,
    );

    expect(this.application.itemManager.items.length).to.equal(this.expectedItemCount);

    expect(tag.content.references.length).to.equal(1);
    expect(tag.noteCount).to.equal(1);

    expect(note.content.references.length).to.equal(0);
    expect(this.application.itemManager.itemsReferencingItem(note.uuid).length).to.equal(1);
  });

  it('importing same note many times should create only one duplicate', async function () {
    /**
     * Used strategy here will be KEEP_LEFT_DUPLICATE_RIGHT
     * which means that new right items will be created with different
     */
    const notePayload = Factory.createNotePayload();
    await this.application.itemManager.emitItemFromPayload(
      notePayload,
      PayloadSource.LocalSaved
    );
    this.expectedItemCount++;
    const mutatedNote = CreateMaxPayloadFromAnyObject(
      notePayload,
      {
        content: {
          ...notePayload.content,
          title: `${Math.random()}`
        }
      }
    );
    await this.application.importData(
      {
        items: [
          mutatedNote,
          mutatedNote,
          mutatedNote,
        ]
      },
      undefined,
      true,
    );
    this.expectedItemCount++;
    expect(this.application.itemManager.notes.length).to.equal(2);
    const imported = this.application.itemManager.notes.find((n) => n.uuid !== notePayload.uuid);
    expect(imported.content.title).to.equal(mutatedNote.content.title);
  });

  it('importing a tag with lesser references should not create duplicate', async function () {
    const pair = Factory.createRelatedNoteTagPairPayload();
    const tagPayload = pair[1];
    await this.application.itemManager.emitItemsFromPayloads(
      pair,
      PayloadSource.LocalChanged
    );
    const mutatedTag = CreateMaxPayloadFromAnyObject(
      tagPayload,
      {
        content: {
          ...tagPayload.safeContent,
          references: []
        }
      }
    );
    await this.application.importData(
      {
        items: [
          mutatedTag
        ]
      },
      undefined,
      true,
    );
    expect(this.application.itemManager.tags.length).to.equal(1);
    expect(this.application.itemManager.findItem(tagPayload.uuid).content.references.length).to.equal(1);
  });

  it('importing data with differing content should create duplicates', async function () {
    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];
    await this.application.itemManager.emitItemsFromPayloads(
      pair,
      PayloadSource.LocalChanged
    );
    this.expectedItemCount += 2;
    const note = this.application.itemManager.notes[0];
    const tag = this.application.itemManager.tags[0];
    const mutatedNote = CreateMaxPayloadFromAnyObject(
      notePayload,
      {
        content: {
          ...notePayload.safeContent,
          title: `${Math.random()}`
        }
      }
    );
    const mutatedTag = CreateMaxPayloadFromAnyObject(
      tagPayload,
      {
        content: {
          ...tagPayload.safeContent,
          title: `${Math.random()}`
        }
      }
    );
    await this.application.importData(
      {
        items: [
          mutatedNote,
          mutatedTag
        ]
      },
      undefined,
      true,
    );
    this.expectedItemCount += 2;
    expect(this.application.itemManager.items.length).to.equal(this.expectedItemCount);

    const newNote = this.application.itemManager.notes.find((n) => n.uuid !== notePayload.uuid);
    const newTag = this.application.itemManager.tags.find((t) => t.uuid !== tagPayload.uuid);

    expect(newNote.uuid).to.not.equal(note.uuid);
    expect(newTag.uuid).to.not.equal(tag.uuid);

    const refreshedTag = this.application.itemManager.findItem(tag.uuid);
    expect(refreshedTag.content.references.length).to.equal(2);
    expect(refreshedTag.noteCount).to.equal(2);

    const refreshedNote = this.application.itemManager.findItem(note.uuid);
    expect(refreshedNote.content.references.length).to.equal(0);
    expect(this.application.itemManager.itemsReferencingItem(refreshedNote.uuid).length).to.equal(2);

    expect(newTag.content.references.length).to.equal(1);
    expect(newTag.noteCount).to.equal(1);

    expect(newNote.content.references.length).to.equal(0);
    expect(this.application.itemManager.itemsReferencingItem(newNote.uuid).length).to.equal(1);
  });

  it('when importing items, imported values should not be used to determine if changed',
    async function () {
      /**
       * If you have a note and a tag, and the tag has 1 reference to the note,
       * and you import the same two items, except modify the note value so that
       * a duplicate is created, we expect only the note to be duplicated, and the
       * tag not to. However, if only the note changes, and you duplicate the note,
       * which causes the tag's references content to change, then when the incoming
       * tag is being processed, it will also think it has changed, since our local
       * value now doesn't match what's coming in. The solution is to get all values
       * ahead of time before any changes are made.
       */
      const note = await Factory.createMappedNote(this.application);
      const tag = await Factory.createMappedTag(this.application);
      this.expectedItemCount += 2;

      await this.application.itemManager.changeItem(tag.uuid, (mutator) => {
        mutator.addItemAsRelationship(note);
      });

      const externalNote = Object.assign({},
        {
          uuid: note.uuid,
          content: note.getContentCopy(),
          content_type: note.content_type
        }
      );
      externalNote.content.text = `${Math.random()}`;

      const externalTag = Object.assign({},
        {
          uuid: tag.uuid,
          content: tag.getContentCopy(),
          content_type: tag.content_type
        }
      );

      await this.application.importData(
        {
          items: [
            externalNote,
            externalTag
          ]
        },
        undefined,
        true,
      );
      this.expectedItemCount += 1;

      /** We expect now that the total item count is 3, not 4. */
      expect(this.application.itemManager.items.length).to.equal(this.expectedItemCount);

      const refreshedTag = this.application.itemManager.findItem(tag.uuid);
      /** References from both items have merged. */
      expect(refreshedTag.content.references.length).to.equal(2);
    });

    it('should keep imported items that were previously deleted', async function () {
      await Factory.registerUserToApplication({
        application: this.application,
        email: this.email,
        password: this.password,
      });
      const [note, tag] = await Promise.all([
        Factory.createMappedNote(this.application),
        Factory.createMappedTag(this.application),
      ]);
      await this.application.sync({ awaitAll: true });

      await this.application.deleteItem(note);
      expect(this.application.findItem(note.uuid)).to.not.exist;

      await this.application.deleteItem(tag);
      expect(this.application.findItem(tag.uuid)).to.not.exist;

      await this.application.importData(
        {
          items: [note, tag]
        },
        undefined,
        true,
      );
      expect(this.application.itemManager.notes.length).to.equal(1);
      expect(this.application.findItem(tag.uuid).deleted).to.be.false;
      expect(this.application.itemManager.tags.length).to.equal(1);
      expect(this.application.findItem(note.uuid).deleted).to.be.false;
    });

    it('should import data from encrypted payload', async function () {
      const passwordForDecrypting = '1234567890';
      const encryptedPayload = {
        uuid: 'e3acaf70-3f57-4366-84d2-f3605b35a10f',
        content_type: 'Note',
        created_at: '2020-07-01T03:56:29.511Z',
        updated_at: '2020-07-01T03:58:32.029Z',
        enc_item_key: '003:d53aeaf89fdc0b2d31694674bacf75d35ee15978ff8c98402c8598730e1fec8d:e3acaf70-3f57-4366-84d2-f3605b35a10f:13d7a02a11341649c441f06f4de9a089:uFYSNCmJOFT5Im4Yek5dVCE9vMWXsbfVweyuFL17bXKKQ9GexTTQh+IA6HEvF2CSXgbVQqafpnPPSvg503jfqMkTXTPb69R7WLsX/xWkoR/PbGZFxdlyhIJZfiOIOp4vxlI5U4CGrcYE7qHc0PfOfUi0rJry02E4NfN+tyFmmmMQLnadQ9Qn9GiMffP62Qry:eyJwd19ub25jZSI6ImM1ZGJmZmZjMzEyNDE1YzA3NWQyMDM0MjlkNmY3OGZjMjU0NjY4NDc0NjJhMmNiYjA0ZTM5Y2MxNDM0ZTAwMmYiLCJwd19jb3N0IjoxMTAwMDAsImlkZW50aWZpZXIiOiJ0ZXN0aW5nQHRlc3Qtc24ub3JnIiwidmVyc2lvbiI6IjAwMyJ9',
        content: '003:d01f296b7e0d2408c4b2a319e9ad36acaf74d4a6c136a15a430b9fba96e512c3:e3acaf70-3f57-4366-84d2-f3605b35a10f:c15a224754e405e4bdabd7973ea212d7:/TA9r+xdWP4UHML/cps0LcRbk4j99eTQz+nFOoboeWHI+a/Iz+qssUnvwWL5xcUtu6P9D6CZ+TBw4O7xIeqD2kuaDDSSJk+x204quVWuJLZzbTcBk2vGftWUAdhbe0Ngrs90u2Znqjkl7VuWq6cRfHzIbRs3fMrKQqOY/NLJzGIJ51jlZjosaj+Kaid3L/jc6wzVd+OXAgqxh/++9SiaC6/DdtUbwKPbxGJLmxPcSLQQYgB0ZKoYJNU+fYFnRke6E1v0oHnKqqYALJ1DnyPZ9V0jWqP3k8Kz8jLjw2iDi/s=:eyJwd19ub25jZSI6ImM1ZGJmZmZjMzEyNDE1YzA3NWQyMDM0MjlkNmY3OGZjMjU0NjY4NDc0NjJhMmNiYjA0ZTM5Y2MxNDM0ZTAwMmYiLCJwd19jb3N0IjoxMTAwMDAsImlkZW50aWZpZXIiOiJ0ZXN0aW5nQHRlc3Qtc24ub3JnIiwidmVyc2lvbiI6IjAwMyJ9',
        auth_hash: null
      };
      const result = await this.application.importData(
        {
          keyParams: {
            'pw_nonce': 'c5dbfffc312415c075d203429d6f78fc25466847462a2cbb04e39cc1434e002f',
            'pw_cost': 110000,
            'identifier': 'testing@test-sn.org',
            'version': '003'
          },
          items: [encryptedPayload]
        },
        passwordForDecrypting,
        true,
      );
      expect(result).to.not.be.undefined;
      expect(result.affectedItems.length).to.be.eq(1);
      expect(result.errorCount).to.be.eq(0);

      const decryptedNote = result.affectedItems[0];
      expect(decryptedNote.title).to.be.eq('Encrypted note');
      expect(decryptedNote.text).to.be.eq('This is a simple note.');
    });
});
