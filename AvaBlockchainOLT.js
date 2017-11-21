var http = require('http');
var url = require('url');
var path = require('path');
var express = require('express');
const request = require('request');
const async = require('async');
var bodyParser = require('body-parser');
var bip39 = require('bip39');
var bitcoin = require("bitcoinjs-lib");

var params;                       //Contains all the parameters: the bitcoin account, the amount and the attendees
var bitcoinNode;                  //Bitcoin Wallet from where the coins are dispatched
var network = bitcoin.networks.bitcoin; //The network used for the transactions
var utxo = [];                    //Stores the unspent transactions on the wallet
var account;                      //The BIP44 account in use for this session

const rootURL = "http://blockchain.info/blocks?format=json";
const blockURL = 'http://blockchain.info/block/';
const addrURL = 'https://blockchain.info/fr/unspent?active=';
const ws = 'wss://ws.blockchain.info/inv';
const PORT = process.env.PORT || 5000;

var app = express();
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true }));

//fetchBlocks();

app.get('/', function(req, out) {
  console.log("root");
  //fetchBlocks();
  out.sendFile(path.join(__dirname + '/res/index.html'));
});

app.get('/favicon.ico', function(req, out) {
  console.log("favicon");
  out.sendFile(path.join(__dirname + '/res/favicon.ico'));
});

app.post('/parameters', function(req, out) {
  //  Receive all the parameters for the course:
  //  + the list of firstnames + names + email addresses of the attendees
  //  + the private key of the address containing the bitcoins we are going to dispatch (WIP)
  //  + the amount of money to be transfered to each attendee
  // these parameters will be stored in memory in the global variable params
  console.log("parameters");
  params = req.body;

  if (bip39.validateMnemonic(params.address) == false) {
    out.status(403).end();
    return;
  }

  var seed = bip39.mnemonicToSeed(params.address);
  bitcoinNode = bitcoin.HDNode.fromSeedBuffer(seed);
  collectUtxo(0, out);    //collect all the utxo and pre-allocate the coins to the students
});

app.get('/res/:name', function(req, out) {
  name = req.params.name;
  console.log(name);
  out.sendFile(path.join(__dirname + '/res/' + name));
});

app.listen(PORT);

function collectUtxo(start, out) {
  //Explore 20 (specified by the BIP44) child addresses from the start. For each retrieve the Utxo
  //If there are still utxo on continue exploring
  //When this is done pre allocate the funds to the different address for the students
  //Firt build an array of the different addresses
  var child = [];
  for (var i = 0 ; i < 20 ; i++) { //We scan BIP44 account 0 where the funds are arriving
    child[i] = bitcoinNode.deriveHardened(44).deriveHardened(0).deriveHardened(0).derive(0).derive(i);
  }
  //Call the http request asynchronously for each address
  async.map(child, function(addr, callback) {

    myURL = addrURL + addr.getAddress(); + "?format=json"

    request(myURL, { json: true }, (err, res, body) => {
      if (err) { return callback(err); }
      //Build up the resuls storing the utxo of each address
      var ret = {};
      ret['address'] = addr.getAddress();
      ret['utxo'] = body;
      return callback(null, ret);
    });
  }, function(err, results) {
      if (err) { return console.log(err); }
      //retrieving the addresses has been successfull -> strore the different addresses and their Utxo
      processUtxo(results);
      if (typeof results[results.length -1].utxo.unspent_outputs != 'undefined') collectUtxo(start + 20, out); //All the explored addresses have utxo, let's continue
      else return(allocateAmounts(out)); //All the utxo have been retrieved. Now preallocate the funds to the students
  });
}

function allocateAmounts(out) {
  //All the utxo from the Avaloq's wallet have been retrieved and stored in the global variable Utxo
  //Now we are going to pre allocate the funds to each students moving the money to different addresses for each student inside the Wallet
  account = findFreeAccount();
  var nb = params.students.length;        //Nb students
  var amount = params.amount * 100000;    //From mBitcoin to satoshis
  var fees = params.fees * (200 + (50 * nb));   //TODO: fees evalution to be improved using the tranasaction length
  var unitFees = 200 * params.fees;             //Fees for each student. TODO: improve this evaluation
  var total = (amount + unitFees) * nb + fees;
  var txb = new bitcoin.TransactionBuilder(network, 20000);

  //Go through the different utxo from the different addresses and build up the input
  var output = [];
  var sum = 0;
  for (i = 0 ; sum < total ; i++) {
    sum += utxo[i].amount;
    txb.addInput(utxo[i].hash, 0); // previous transaction output
    output.push({'in_out': 'in', 'address': utxo[i].address, 'tx': utxo[i].hash, 'amount': utxo[i].amount});
  }

  var child;
  for (var i = 0 ; i < nb ; i++) {
    child = bitcoinNode.deriveHardened(44).deriveHardened(0).deriveHardened(account).derive(0).derive(i);
    txb.addOutput(child.getAddress(), amount + unitFees);
    output.push({'in_out': 'out', 'address': child.getAddress(), 'tx': '', 'amount': amount + unitFees});
  }
  txb.addOutput(utxo[0].address, sum - total);
  output.push({'in_out': 'out', 'address': utxo[0].address, 'tx': '', 'amount': sum - total});

  txb.sign(0, bitcoinNode);
  console.log(txb.build().toHex());
  console.log(output);
  if (out != null) { console.log('retour'); out.status(200).json(output).end();}
}

function findFreeAccount() {
  //Generates addresses for the different BIP44 accounts and checks if those addresses have been used.
  //Returns the first free account;
  //TODO: to be implemented
  return(1);
}

function processUtxo(res) {
  // We go through the array of address and amounts which have been scanned to find the utxo
  // and we fill the global array containing the utxo with the hash and the remaining value (in satoshis)

  for (var i = 0 ; i < res.length ; i++) {
    if (typeof res[i].utxo.unspent_outputs == 'undefined') break;

    for (var j = 0 ; j < res[i].utxo.unspent_outputs.length ; j++)
      utxo.push({ 'hash' : res[i].utxo.unspent_outputs[j].tx_hash, 'amount' : res[i].utxo.unspent_outputs[j].value, 'address' : res[i].address});
  }
}
