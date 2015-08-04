var WalletCore = require('cc-wallet-core')
var cclib = WalletCore.cclib
var bitcoin = cclib.bitcoin
var BigInteger = require('bigi')
var request = require('request')
var nopt = require('nopt')

var Q = require('q')
var getbtc = require('./get-btc')



var args = nopt({url: String, seed: String, command: String, issue_tx: String})

var seed = args.argv.remain.shift() || args.seed
var command = args.argv.remain.shift() || args.command || 'show'

var base_uri = args.url || 'http://localhost:4444/api/'
var issue_tx = args.issue_tx; //For transfer

var address_key_map



function genkey(i) {
  var d = BigInteger.fromBuffer(bitcoin.crypto.sha256(seed + i.toString()))
  var k = new bitcoin.ECKey(d)
  return k
}

function getaddress(i) {
  return genkey(i).pub.getAddress(bitcoin.networks.testnet).toBase58Check()
}

function api_call(method, data, cb) {
  request({method: 'post', uri: base_uri + method, body: data, json: true},
  function (err, response, body) {
    if (err) {
      console.log("Post to api error:", err)
      cb(err, null);
    }
    else if (response.statusCode !== 200) {
      console.log('ERROR', response.statusCode, body)
      cb(err, null);
    } else {
      cb(null, body)
    }
  })
}

function init() {
  address_key_map = {}
  for (var i = 0; i < 5; i++)
    address_key_map[getaddress(i)] = genkey(i)
}

function show() {
  console.log(getaddress(0))
  var deferred = Q.defer()
  api_call('getUnspentCoins', {addresses: [getaddress(0)], color: ""},
    function (err, data) {
      if (err) {
        console.log('ERROR', err)
        deferred.reject(err)
      }
      else {
        console.log(data)
        if (data.coins.length === 0) console.log('please send some testnet bitcoins to address above')
        deferred.resolve(data)
      }
    })
  return deferred.promise
}

var issue = function () {
  var params = {
    source_addresses: { "": [getaddress(0)] },
    change_address: { "": getaddress(1) },
    target: {address: getaddress(2), value: 2800},
    color_kernel: 'epobc'
  }
  var deferred = Q.defer()
  console.log('Create Issue Transaction:')
  console.log(params)

  api_call('createIssueTx', params, function (err, res) {
    if (err) {
      console.log('CreateIssueTx returned error:', err)
      process.exit(0)
    }
    console.log('CreateIssueTx result:', res)

    var transaction = bitcoin.Transaction.fromHex(res.tx)
    console.log('Transaction:', transaction);

    var txb = bitcoin.TransactionBuilder.fromTransaction(transaction)

    res.input_coins.forEach(function (coin, index) {
      var key = address_key_map[coin.address]
      if (!key) {
        console.log('lack key for address ' + coin.address)
        process.exit(0)
      }
      console.log("Signing, " + coin.address, + 'at index ' + index);
      txb.sign(index, key)
    })
    var tx = txb.build()
    console.log('Transaction builder created transaction:')
    console.log(tx.toHex())

    console.log('Now broadcasting the transaction')

    issue_tx = bitcoin.Transaction.fromHex(tx.toHex()).getId();

    console.log("issue_tx", issue_tx)

    api_call('broadcastTx', {tx: tx.toHex() }, function (err, res) {

      if (err) {
        console.log('broadcastTx returned an error')
        console.log(err)
        deferred.reject(err)
      } else {
        console.log('broadcastTx returned this result:')
        console.log(res)
        console.log("TX:", tx)

        deferred.resolve()
      }
    })
    
  })
  return deferred.promise
}

var transfer = function () {
  //Assumes we have issued

  if (! issue_tx) {
    console.log("Specify previous issuance transacion with --issue_tx=previously-printed-transaction-id")
    exit(0)
  }
    
  var previousChange = getaddress(1)
  var previouslyIssuedColorAddr = getaddress(2)
  var issuanceTransaction = issue_tx

  var source_addresses = {}
  var change_address = {}

  var colorDescriptor = 'epobc:' + issuanceTransaction +':0:0'

  source_addresses[""] = [previousChange]
  source_addresses[colorDescriptor] = [previouslyIssuedColorAddr]

  change_address[""] = previousChange
  change_address[colorDescriptor] = previouslyIssuedColorAddr

  var newReceiver = getaddress(4)
  
  var targets = [
   {
     address: newReceiver,
     color: colorDescriptor,
     value: 1000
   }
  ]
  
  var params = {
    source_addresses: source_addresses,  // source for bitcoins and colored coins
    change_address: change_address, // address used for a change if coins are not spent fully
    targets: targets // see description in 'General conventions' section
  }
  var deferred = Q.defer()
  console.log('Create Transfer Transaction:')

  console.log(params)

  api_call('createTransferTx', params, function (err, res) {
    if (err) {
      console.log('CreateTransferTx returned error:', err)
      process.exit(0)
    }
    console.log('CreateTransferTx result:', res)

    var transaction = bitcoin.Transaction.fromHex(res.tx)

    var txb = bitcoin.TransactionBuilder.fromTransaction(transaction)

    res.input_coins.forEach(function (coin, index) {
      var key = address_key_map[coin.address]
      if (!key) {
        console.log('lack key for address ' + coin.address)
        process.exit(0)
      }
      console.log("Signing, " + coin.address, + 'at index ' + index);
      txb.sign(index, key)
    })
    var tx = txb.build()

    console.log('Transaction builder created transaction:')
    console.log(bitcoin.Transaction.fromHex(tx.toHex()).getId());
    console.log(tx.getId && tx.getId)

    console.log('Now broadcasting the transaction')
    api_call('broadcastTx', {tx: tx.toHex() }, function (err, res) {

      if (err) {
        console.log('broadcastTx returned an error')
        console.log(err)
        deferred.reject(err)
      } else {
        console.log('broadcastTx returned this result:')
        console.log(res)
        deferred.resolve()
      }
    })
  })
  return deferred.promise
}


function usage() {
  console.log('USAGE:')
  console.log(require('fs').readFileSync('usage.txt').toString())
  process.exit(1)
}

function autotest () {
  return show()
         .then(function (data) {
           if (!data.coins.length) {
             console.log('Loading BTC to ' + getaddress(0))
             return getbtc.getSomeBTC(getaddress(0))
           }
         })
         .delay(60000)
         .then(issue)
         .then(function () {
           return getbtc.waitForTxHash(issue_tx)
         })
         .delay(60000)
         .then(transfer)
}

function main() {
  if (!seed) {
    usage()
  }

  init()

  console.log('command:' + command)
  
  var dispatch = {
      'show': show,
      'autotest': autotest,
      'issue': issue,
      'transfer': transfer
  }
  var fn = dispatch[command];
  if (fn) {
    fn()
  } else {
    console.log('Unknown command')
  }
}

if (global.describe) {
  describe('API-test', function() {
    this.timeout(1000 * 60 * 40); //40 minutes
    var server;
    it('main functional test', function (done) {
      var args = {
        port: 5555,
        testnet: true
      }
      server = require('../server')

      base_uri = 'http://localhost:' + args.port + '/api/'
      command = 'autotest'
      seed = 'hello' + Date.now()
      console.log("Seed: ", seed)
      server.startService(args)
      .then(main)
      .done(function () {
        done()
      },
      function () {
        throw(new Error("Build failed"))
      }
      )
    })
    after(function () {
      server.stopService()
    })
  })
}

if (require.main === module) {
  main()
}

