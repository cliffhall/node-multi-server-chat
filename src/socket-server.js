// socket-server.js

// Get config file specified on command line
var config;
var path = process.argv[2];
var myid = process.argv[3];
var usage = 'Usage: node socket-server.js path/to/servers.json server-id';
if (!path) {
    console.log(usage);
    process.exit();
} else {
    console.log('Loading config from: ' + path);
    try {
        var fs = require('fs');
        config = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (err) {
        console.log('Loading failed or config could not be parsed.');
        process.exit();
    }
    console.log('Config loaded.');
    console.log('My id: ' + myid);
}

// Splice out the config for this server
var myConfig;
var i,server;
for (i=0; i<config.servers.length; i++) {
    server = config.servers[i];
    if (server.id === myid) {
        myConfig = config.servers.splice(i,1)[0];
        break;
    }
}

// Bail if we didn't find our config
if (!myConfig){
    console.log(usage);
    process.exit();
}

// Messaging constants
const IM = 'im';
const IDENT = 'identify';
const CONNECT = 'connect';
const CONNECTION = 'connection';
const DISCONNECT = 'disconnect';

// Connection hashes
var peers = {};
var users = {};
var usersByConnection = {};

// Listen for clients
var port = myConfig.port;
var socket = require('socket.io')(port);
socket.on(CONNECTION, onConnection);
console.log('Listening for connections on port:' + port);

// Handle connection from clients (peers or users)
function onConnection(connection) {

    // Listen for message events
    connection.on(IM, onIm);
    connection.on(IDENT,onIdentify);
    connection.on(DISCONNECT, onDisconnect);

    // Handle an identification event from a user
    function onIdentify(userId) {
        var user = users[userId];
        if (user){
            user.push(connection);
        } else {
            users[userId] = [connection];
        }
        usersByConnection[connection.id] = userId;
        reportUserConnections(userId);
    }

    // Handle an 'im' event from a client
    function onIm(message) {
        var forwarded = message.forwarded?'forwarded':'';
        console.log('Received '+ forwarded + ' IM from ' + message.from + ' to '+ message.to + ': ' + message.text);
        var userConnections = users[message.to];
        if (userConnections) { // User is connected to this server
            console.log('Recipient ' + message.to + ' has ' + userConnections.length + ' connection(s) to this server, sending...');
            var userConnection, i;
            for (i=0;i<userConnections.length;i++){
                userConnection = userConnections[i];
                userConnection.emit(IM, message);
            }
        } else {
            console.log('Recipient ' + message.to + ' not on this server');
        }

        // If message wasn't forwarded from another server, also forward to peers
        if (!message.forwarded){
            console.log('Forwarding to peers...');
            message.forwarded = true;
            var peer, peerId, j;
            for (j=0;j<config.servers.length;j++){
                peerId = config.servers[j].id;
                peer = peers[peerId];
                peer.emit(IM, message);
            }
        } else {
            console.log('Message was forwarded, the buck stops here');
        }

    }

    // Handle disconnection from a client
    function onDisconnect() {
        // If it is a user, remove from users list
        var userId = usersByConnection[connection.id];
        if (userId) {
            delete usersByConnection[connection.id];
            var userConnections = users[userId];
            var userConnection;
            if (userConnections) {
                console.log('User ' + userId + ' disconnected.');
                for (var i=0;i<userConnections.length;i++) {
                    userConnection = userConnections[i];
                    if (userConnection.id === connection.id){
                        userConnections.splice(i,1);
                        break;
                    }
                }
                if (userConnections.length > 0) {
                    console.log('User ' + userId + ' still has ' + userConnections.length + ' connections.');
                } else {
                    delete users[userId];
                }
            }
        }

        // Remove listeners
        connection.removeListener(IM, onIm);
        connection.removeListener(IDENT, onIdentify);
        connection.removeListener(DISCONNECT, onDisconnect);
    }

    // Report user connections
    function reportUserConnections(user){
        console.log('User: ' + user + ' connected ' + users[user].length + ' times.');
    }
}

// Initiate connection to peers
var io = require('socket.io-client');
connectToPeers(config.servers);

// Connect to peer servers
function connectToPeers(servers){
    console.log('Attempting to connect to peers...');
    var host, peer, i;
    for (i=0; i<servers.length; i++){
        peer = servers[i];
        if (!peers[peer.id]) {

            // Build host endpoint for peer
            host = 'http://' + peer.ip + ':' + peer.port;

            // Attempt connection
            console.log('Attempt connection to peer: '+peer.id + ' at: ' + host);
            let peerSocket = io.connect(host, {reconnection:true} );
            peerSocket.peerId = peer.id;

            // Handle connection success
            peerSocket.on(CONNECT, function() {

                console.log('Outbound connection to peer: ' + this.peerId);

                // Store the peer connection
                peers[this.peerId] = peerSocket;

                // Listen for peer disconnection
                peerSocket.on(DISCONNECT, onDisconnect);
            });

            // Peer disconnected
            function onDisconnect(){
                console.log('Peer: ' + this.peerId + ' disconnected. Will retry automatically.');
            }
        }

    }
}

