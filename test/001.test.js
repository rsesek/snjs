import '../node_modules/regenerator-runtime/runtime.js';
import '../dist/snjs.js';
import '../node_modules/chai/chai.js';
import './vendor/chai-as-promised-built.js';

const sn_webprotocolManager = new SNProtocolManager(new SNWebCrypto());
const protocol_001 = new SNProtocolOperator001(new SNWebCrypto());

chai.use(chaiAsPromised);
var expect = chai.expect;

describe.only('001 protocol operations', () => {

  var _identifier = "hello@test.com";
  var _password = "password";
  var _keyParams, _keys;

  before((done) => {
    // runs before all tests in this block
    protocol_001.createRootKey({identifier: _identifier, password: _password}).then((result) => {
      _keyParams = result.keyParams;
      _keys = result.keys;
      done();
    })
  });

  it('cost minimum', () => {
    var currentVersion = sn_webprotocolManager.version();
    expect(sn_webprotocolManager.costMinimumForVersion("001")).to.equal(3000);
  });

  it('generates random key', async () => {
    const length = 128;
    const key = await protocol_001.crypto.generateRandomKey(length);
    expect(key.length).to.equal(length/4);
  });

  it('generates valid keys for registration', async () => {
    const result = await protocol_001.createRootKey({identifier: _identifier, password: _password});
    expect(result).to.have.property("keys");
    expect(result).to.have.property("keyParams");

    expect(result.keys).to.have.property("pw");
    expect(result.keys).to.have.property("ak");
    expect(result.keys).to.have.property("mk");

    expect(result.keyParams).to.have.property("pw_nonce");
    expect(result.keyParams).to.have.property("pw_cost");
    expect(result.keyParams).to.have.property("pw_salt");
  });

  it('properly encrypts and decrypts', async () => {
    var text = "hello world";
    var key = _keys.mk;
    var iv = await protocol_001.crypto.generateRandomKey(128);
    let wc_encryptionResult = await protocol_001.encryptText(text, key, iv);
    let wc_decryptionResult = await protocol_001.decryptText({contentCiphertext: wc_encryptionResult, encryptionKey: key, iv: iv})
    expect(wc_decryptionResult).to.equal(text);
  });

  it('generates existing keys for auth params', async () => {
    const result = await protocol_001.computeRootKey({password: _password, keyParams: _keyParams});
    expect(result).to.have.property("pw");
    expect(result).to.have.property("ak");
    expect(result).to.have.property("mk");
    expect(result).to.eql(_keys);
  });

})
