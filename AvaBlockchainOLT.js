var http = require('http');
var url = require('url');
var path = require('path');
var express = require('express');
const request = require('request');
const async = require('async');
var bodyParser = require('body-parser');
var bip39 = require('bip39');
var bitcoin = require("bitcoinjs-lib");
var WebSocketClient = require('websocket').client;

var Config = [];                   //Contains all the parameters for all the courses: the bitcoin account, the amount and the attendees
var BitcoinNode;                  //Bitcoin Wallet from where the coins are dispatched
var network = bitcoin.networks.bitcoin; //The network used for the transactions
var Utxo = [];                    //Stores the unspent transactions on the wallet
var Account;                      //The BIP44 account in use for this session
var CacheHashTbl = new Map();     //Map containing the hashes of the retrieved blocks
var CacheHeightTbl = new Map();   //Map containing the Heights of the retrieved blocks
var CacheResults = [];            //Array of all the retrieved blocks

const rootURL   = "http://blockchain.info/blocks?format=json";
const blockURL  = 'http://blockchain.info/block/';
const addrURL   = 'https://blockchain.info/fr/unspent?active=';
const txAddrURL = 'https://blockchain.info/fr/rawaddr/';
const ws        = 'wss://ws.blockchain.info/inv';
const PORT      = process.env.PORT || 5000;
const LINES     = 10;

var client = new WebSocketClient();

client.on('connectFailed', function(error) {
    console.log('Connect Error: ' + error.toString());
});

client.on('connect', function(connection) {
    console.log('WebSocket Client Connected');
    connection.on('error', function(error) {
        console.log("Connection Error: " + error.toString());
    });
    connection.on('close', function() {
        console.log('WS Connection Closed');
    });
    connection.on('message', function(message) {
        if (message.type === 'utf8') {
          console.log("New block received")
          res = JSON.parse(message.utf8Data);
          fetchBlock(res.x.hash);
        }
    });

    if (connection.connected) { connection.send(JSON.stringify({"op":"blocks_sub"}));}
});

//client.connect(ws, null);


var app = express();
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true }));

app.use("/res", express.static(__dirname + '/res'));
app.use("/js", express.static(__dirname + '/js'));
app.use("/css", express.static(__dirname + '/css'));
app.use("/html", express.static(__dirname + '/html'));

app.use(express.static('public'));

fetchBlocks();
loadConfig();

app.get('/favicon.ico', function(req, out) {
  console.log("favicon.ico");
  out.sendFile(path.join(__dirname + '/res/favicon.ico'));
});

app.get('/', function(req, out) {
  console.log("root");
  out.sendFile(path.join(__dirname + '/html/index.html'));
});
app.get('/createCourse', function(req, out) {
  console.log("createCourse");
  out.sendFile(path.join(__dirname + '/html/createCourse.html'));
});
app.get('/createWallet', function(req, out) {
  console.log("createWallet");
  out.sendFile(path.join(__dirname + '/html/createWallet.html'));
});

app.post('/post/createCourse', function(req, out) {
  //  Create and store a new course : the name and the dates are sent and the Course ID is sent as a response
  //
  //  Receive all the parameters for the course:
  //  + the list of firstnames + names + email addresses of the attendees
  //  + the private key of the address containing the bitcoins we are going to dispatch (WIP)
  //  + the amount of money to be transfered to each attendee
  // these parameters will be stored in memory in the global variable params
  console.log("createCourse");
  params = req.body;

  if (bip39.validateMnemonic(params.address) == false) {
    out.status(403).end();
    return;
  }

  Config.push(params);
  saveConfig();
  out.status(200).json({'courseID' : Config.length});

});

app.post('/post/distributeCoins', function(req, out) {
  // Pre-allocate the funds to the students, moving coins to specific address.
  // Later on the students will trigger a transaction to move those funds to their own addresses
  // The parameters received are the same as for the createCourse call with additionnally the courseID
  //TODO: this functionnality should be disabled when the coins have already been distributed to prevent any double distribution
  //The log of the coins which have been distributed will be added in the Config object and tested here. If the current course
  //as already this attribute the distribution will be aborted.
  console.log("distributeCoins");
  params = req.body;

  if (params.courseID == null) {
    out.status(404).end();
    return;
  }
  if (bip39.validateMnemonic(params.address) == false) {
    out.status(403).end();
    return;
  }

  Config[params.courseID] = params;
  var seed = bip39.mnemonicToSeed(params.address);
  BitcoinNode = bitcoin.HDNode.fromSeedBuffer(seed);
  collectUtxo(0, out, params.courseID);    //collect all the utxo and pre-allocate the coins to the students
});

app.get('/lastBlocks/:num', function(req, out) {
  console.log("lastBlocks");
  num = parseInt(req.params.num);
  var tbl = [];

  for (var i = 0 ; (i < num) && (i < CacheResults.length) ; i++) {
    block = CacheResults[i];
    val = computeBlock(block);
    date = new Date(block.time*1000);
    datestr = date.toISOString().replace(/T/, ' ').replace(/\..+/, '');
    tbl.push({"row" : i, "height" : String(block.height), "amount" : (val.output/1E8).toFixed(2), "fees": (val.fees/1E8).toFixed(2), "time": datestr, "nbTx": block.n_tx, "size": block.size, "hash": block.hash});
  }
  out.status(200).json(tbl).end();
});

app.get('/getBlock/:num', function(req, out) {
  console.log("getBlock");
  num = parseInt(req.params.num);

  block = CacheHeightTbl.get(num);

  if (block == undefined) out.status(404).end();
  else out.status(200).json(block).end();
});

app.get('/txAddress/:num', function(req, out) {
  console.log("txAddress");

  request(txAddrURL + req.params.num, { json: true }, (err, res, body) => {
    if (err) { return console.log(err); }
    //TODO proper HTML rendering of this information
    out.status(200).render('transactions.ejs', {data: body});
  });
});

app.post('/post/createWallet', function(req, out) {
  // Create a wallet and a public bitcoin address associated to the wallet. Transfer of the pre allocated amont of money will be trigered
  // the transaction details will be displayed. The student could see how the transaction is progressing getting validated ...
  // another address will be created so that the sytudent can transfer money from one address to the other.
  //The input is the student's email address
  console.log("createWallet - post");
  email = req.body.email;
  var find, courseID;
  find = -1;
  courseID = -1;
  for (var j = 0 ; j < Config.length ; j++) {
    for (var i = 0 ; i < Config[j].students.length ; i++) { //search dor the email address in the course parameters
      if (Config[j].students[i].email == email) { find = i; courseID = j; }
    }
  }
  if (find == -1) { out.status(401).end(); return; }  //The student does not exist in the list sent by the organiser

  if (typeof Config[courseID].students[find].sent != 'undefined') {   //The money has already been sent. Too Bad! Nice try!
    out.status(403).end();
    return;
  }

  Config[courseID].students[find]['sent'] = true;
  var words = bip39.generateMnemonic(128);
  var seed = bip39.mnemonicToSeed(words);
  var node = bitcoin.HDNode.fromSeedBuffer(seed);
  var child = node.derivePath("m/44'/0'/0'/0/0")
  var address = child.getAddress();
  ret = {};
  ret['words'] = words;
  ret['address'] = address;
  ret['tx_hash'] = processPayment(address, courseID);
  out.status(200).json(ret).end();
});

app.listen(PORT);

function loadConfig(){
  //TODO: Load the config from a file where all the informations are stored (Json dump of the Config object)
  return;
}

function saveConfig() {
  //TODO: save in json in a file the Config object which contains the information about all the courses
  return;
}

function processPayment(addr, courseID) {
    //TODO: transfer the predefined amount of bitcoin from the Avaloq's wallet to the student's address
    // Each utxo should be checked to verify if the remaining amount is enough to transfer the defined amount to the students
    // If not, multiple utx should be used
    // Then the transaction is created and signed from Avaloq's wallet
    var txb = new bitcoin.TransactionBuilder(network, 20000);
    var amount = Config[courseID].amount * 100000; //convert mBitcoins in Satoshis
    var fees = Config[courseID].fees * 240;     //TODO: have a better estimation of the transaction size estimated here to 240 bytes

    //Go through the different utxo from the different addresses and build up the input
    var sum = 0;
    for (i = 0 ; sum < amount ; i++) {
      sum += Utxo[i].amount;
      txb.addInput(Utxo[i].hash, 0); // previous transaction output
    }

    txb.addOutput(addr, amount);
    txb.addOutput(Utxo[0].address, sum - amount - fees);
    txb.sign(0, BitcoinNode);
    console.log(txb.build().toHex());
}

function collectUtxo(start, out, courseID) {
  //Explore 20 (specified by the BIP44) child addresses from the start. For each retrieve the Utxo
  //If there are still utxo on continue exploring
  //When this is done pre allocate the funds to the different address for the students
  //Firt build an array of the different addresses
  var child = [];
  for (var i = 0 ; i < 20 ; i++) { //We scan BIP44 account 0 where the funds are arriving
    child[i] = BitcoinNode.deriveHardened(44).deriveHardened(0).deriveHardened(0).derive(0).derive(i);
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
      if (typeof results[results.length -1].utxo.unspent_outputs != 'undefined') collectUtxo(start + 20, out, courseID); //All the explored addresses have utxo, let's continue
      else return(allocateAmounts(out, courseID)); //All the utxo have been retrieved. Now preallocate the funds to the students
  });
}

function allocateAmounts(out, courseID) {
  //All the utxo from the Avaloq's wallet have been retrieved and stored in the global variable Utxo
  //Now we are going to pre allocate the funds to each students moving the money to different addresses for each student inside the Wallet
  Account = findFreeAccount();
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
    sum += Utxo[i].amount;
    txb.addInput(Utxo[i].hash, 0); // previous transaction output
    output.push({'in_out': 'in', 'address': Utxo[i].address, 'tx': Utxo[i].hash, 'amount': Utxo[i].amount});
  }

  var child;
  for (var i = 0 ; i < nb ; i++) {
    child = BitcoinNode.deriveHardened(44).deriveHardened(0).deriveHardened(Account).derive(0).derive(i);
    txb.addOutput(child.getAddress(), amount + unitFees);
    output.push({'in_out': 'out', 'address': child.getAddress(), 'tx': '', 'amount': amount + unitFees});
  }
  txb.addOutput(Utxo[0].address, sum - total);
  output.push({'in_out': 'out', 'address': Utxo[0].address, 'tx': '', 'amount': sum - total});

  txb.sign(0, BitcoinNode);
  console.log(txb.build().toHex());           //TODO: Execute the real transaction on the network
  Config[courseID]['transactions'] = output;
  out.status(200).json(output).end();
  saveConfig();
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
      Utxo.push({ 'hash' : res[i].utxo.unspent_outputs[j].tx_hash, 'amount' : res[i].utxo.unspent_outputs[j].value, 'address' : res[i].address});
  }
}

function fetchBlocks(){
  var hash = [];
  //Get the list of the last blocks
  console.log('fetchBlocks');

  request(rootURL, { json: true }, (err, res, body) => {
    if (err) { return console.log(err); }

    for (i = 0 ; i < LINES && i < body.blocks.length; i++) {
      hash[i] = body.blocks[i].hash;
    }

    async.map(hash, function(name, callback) {
      if (CacheHashTbl.has(name)) return(null, null);

      myURL = blockURL + String(name) + "?format=json"

      request(myURL, { json: true }, (err, res, body) => {
        if (err) { return callback(err); }
        storeBlock(body);
        return callback(null, body);
      });
    }, function(err, results) {
        if (err) { return console.log(err); }
    });
  });
}

function fetchBlock(hash){
  console.log('fetchBlock : ' + hash);

  if (CacheHashTbl.has(hash)) return;

  request(blockURL + String(hash) + '?format=json', { json: true }, (err, res, body) => {
    if (err) { console.log(err); return;}

    storeBlock(body);
  });
}

function storeBlock(block){
  console.log('storeBlock');

  CacheResults.push(block);
  CacheResults.sort(function(a,b) {return(b.height - a.height);});
  CacheHashTbl.set(block.hash, block);
  CacheHeightTbl.set(block.height, block);
}

function computeBlock(block){
  var fees = 0;
  var sumInput = 0;
  var sumOutput = 0;

  for (var i = 0 ; i < block.tx.length ; i++) {
    input = 0;
    output = 0;
    reward = false;

    for (var j = 0 ; j < block.tx[i].inputs.length ; j++) {
      reward = false;
      if (typeof block.tx[i].inputs[j].prev_out != 'undefined') input += block.tx[i].inputs[j].prev_out.value;
      else reward = true;
    }
    for (var j = 0 ; (j < block.tx[i].out.length) && !reward ; j++) {
      if (typeof block.tx[i].out[j].value != 'undefined') output += block.tx[i].out[j].value;
    }
    fees += input - output;
    sumInput += input;
    sumOutput += output;
  }
  return({"input": sumInput, "output": sumOutput, "fees": fees});
}
