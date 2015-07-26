var Q = require('q');
var WalletCore = require('cc-wallet-core');
var cclib = WalletCore.cclib;
var ColorTarget = cclib.ColorTarget;
var ColorValue = cclib.ColorValue;
var bitcoin = cclib.bitcoin;
var OperationalTx = WalletCore.tx.OperationalTx;
var RawTx = WalletCore.tx.RawTx;
var CoinList = WalletCore.coin.CoinList;
var transformTx = WalletCore.tx.transformTx;
var Coin = WalletCore.coin.Coin;
var inherits = require('util').inherits;
var BIP39 = require('bip39');
var _ = require('lodash')
var fs = require('fs')

var wallet = null;

function initializeWallet(done) {
  var systemAssetDefinitions = [];

  wallet = new WalletCore.Wallet({
    testnet: true,
    blockchain: { name: 'Naive' },
    // connector: {opts: {url: "http://136.243.23.208:5001"}},
    storageSaveTimeout: 0,
  });
  wallet.on('error', function (error) {
    console.log(error.stack || error);
  });
  wallet.once('syncStop', function () { done(wallet); })
}

function getScriptFromTargetData(target) {
  var target_script = target.script;
  if (!target_script) {
    var target_addr = target.address;
    if (!target_addr) throw new Error('neither target.script nor target.address is provided');
    target_script = bitcoin.Address.fromBase58Check(target_addr).toOutputScript().toHex();
  }
  return target_script;  
}

function CustomOperationalTx(wallet, spec) {
  this.wallet = wallet;
  this.spec = spec;
  this.targets = [];
  var self = this;
  if (spec.targets)
    spec.targets.forEach(function (target) {
      var color_desc = target.color;
      var colordef = wallet.getColorDefinitionManager().resolveByDesc(color_desc);
      self.targets.push(new ColorTarget(getScriptFromTargetData(target),
                                        new ColorValue(colordef, target.value)))
  });
}

inherits(CustomOperationalTx, OperationalTx);

CustomOperationalTx.prototype.getChangeAddress = function (colordef) {
  var color_desc = colordef.getDesc();
  var address = this.spec.change_address[color_desc];
  if (!address)
    throw Error('Change address is not specified for color: "' + color_desc + '"');
  return address;
};

CustomOperationalTx.prototype._getCoinsForColor = function (colordef) {
  var color_desc = colordef.getDesc();

  if (!this.spec.source_addresses[color_desc])
    throw new Error('source addresses not provided for "' + color_desc + '"');
  
  return getUnspentCoins(this.wallet, 
      this.spec.source_addresses[color_desc],
      color_desc).
    then(function (coins) {
      console.log('got coins:', coins)
      return new CoinList(coins)
  })
};

function getUnspentCoins(context, addresses, color_desc) {
  var bc = context.getBlockchain();
  var cd = context.getColorData();

  function getTxFn(txId, cb) {
    function onFulfilled(txHex) { cb(null, bitcoin.Transaction.fromHex(txHex)) }
    function onRejected(error) { cb(error) }
    bc.getTx(txId).then(onFulfilled, onRejected)
  }

  var colordef = wallet.getColorDefinitionManager().resolveByDesc(color_desc);
  return bc.addressesQuery(addresses, {status: 'unspent'}).then(function (res) {
    return Q.all(res.unspent.map(function (unspent) {
      var cvQ = null;
      if (colordef.getColorType() === 'uncolored') 
        cvQ = Q(new ColorValue(colordef, parseInt(unspent.value, 10)))
      else
        cvQ = Q.ninvoke(cd, 'getCoinColorValue',
          {txId: unspent.txid, outIndex: unspent.vount},
          colordef, getTxFn);

      return cvQ.then(function (cv) {
              return new Coin({
                  txId: unspent.txid,
                  outIndex: unspent.vount,
                  value: parseInt(unspent.value, 10),
                  script: unspent.script,
                  address: ""
              }, {
                isAvailable: true,
                getCoinMainColorValue: cv
              })
          })
    }))
  })
}

function getUnspentCoinsData (data) {
  return Q.try(function () {
      if (!data.addresses) res.status(400).json({error: "requires addresses"});
      if (!data.color) res.status(400).json({error: "requires color"});
      return getUnspentCoins(wallet, data.addresses, data.color);
  }).then(function (coins) {
      return Q.all(coins.map(function (coin) {
          return Q.ninvoke(coin, 'getMainColorValue', null, null).then(
            function (cv) {
              var rawCoin = coin.toRawCoin();
              delete rawCoin['address']; // TODO: detect address properly
              rawCoin.color = data.color;
              rawCoin.color_value = cv.getValue();
              return rawCoin
            })
      }))
  })
}

function createTransferTx(data) {
  return Q.try(function () {
    var opTxS = new CustomOperationalTx(wallet, data);
    return Q.nfcall(transformTx, composedTx, 'raw', {});    
  })
}

function createIssueTx(data) {
  return Q.try(function () {
      if (data.targets && !data.target) {
        if (data.targets.length > 1 || data.targets.length == 0) throw new Error('issuance transaction should have a single target');
        data.target = data.targets[0];
        delete data['targets'];
      }
      if (data.targets) throw new Error('both target and targets fields are set');
      if (!data.target) throw new Error('no target provided');

      var opTxS = new CustomOperationalTx(wallet, {
          source_addresses: data.source_addresses,
          change_address: data.change_address
      });
      opTxS.addTarget(new ColorTarget(
          getScriptFromTargetData(data.target),
          new ColorValue(cclib.ColorDefinitionManager.getGenesis(), // genesis output marker
                         parseInt(data.target.value, 10))));
      if (data.color_kernel !== 'epobc') throw new Error('only epobc kernel is supported')
      var cdefCls = cclib.ColorDefinitionManager.getColorDefenitionClsForType('epobc');
      console.log('compose...')
      return Q.nfcall(cdefCls.composeGenesisTx, opTxS).then(function (composedTx) {
          console.log('transforming to raw...')
          return Q.nfcall(transformTx, composedTx, 'raw', {});
      }).then(function (tx) {
        console.log('done')
        return tx.toHex(true);
      })
  })
}

module.exports = {
  initializeWallet: initializeWallet, 
  createIssueTx: createIssueTx,
  createTransferTx: createTransferTx,
  getUnspentCoinsData: getUnspentCoinsData
}