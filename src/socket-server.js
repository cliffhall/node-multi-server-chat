// socket-server.js

// Get config file specified on command line
let config;
let path = process.argv[2];
let myid = process.argv[3];
let usage = 'Usage: node socket-server.js path/to/servers.json server-id';
if (!path) {
    console.log(usage);
    process.exit();
} else {
    console.log(`Loading config from: ${path}`);
    try {
        let fs = require('fs');
        config = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (err) {
        console.log('Loading failed or config could not be parsed.');
        process.exit();
    }
    console.log('Config loaded.');
    console.log(`My id: ${myid}`);
}

// Splice out the config for this server
let myConfig = config.servers.find(server => server.id === myid);

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
let peers = {};
let users = {};
let usersByConnection = {};

// Listen for clients
let port = myConfig.port;
let socket = require('socket.io')(port);
socket.on(CONNECTION, onConnection);
console.log(`Listening for connections on port: ${port}`);

// Handle connection from clients (peers or users)
function onConnection(connection) {

    // Listen for message events
    connection.on(IM, onIm);
    connection.on(IDENT,onIdentify);
    connection.on(DISCONNECT, onDisconnect);

    // Handle an identification event from a user
    function onIdentify(userId) {
        let user = users[userId];
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
        console.log(`Received ${message.forwarded?'forwarded ':''}IM from ${message.from} to ${message.to}: ${message.text}`);
        let userConnections = users[message.to];
        if (userConnections) { // User is connected to this server
            console.log(`Recipient ${message.to} has ${userConnections.length} connection${userConnections.length>1?'s':''} to this server, sending...`);
            userConnections.forEach(userConnection => userConnection.emit(IM, message));
        } else {
            console.log(`Recipient ${message.to} not connected to this server`);
        }

        // If message wasn't forwarded from another server, also forward to peers
        if (!message.forwarded){
            console.log('Forwarding to peers...');
            message.forwarded = true;
            config.servers.forEach( server => {
                let peer = peers[server.id];
                peer.emit(IM, message);
            });
        } else {
            console.log('Message was forwarded, the buck stops here');
        }
    }

    // Handle disconnect from a client
    function onDisconnect() {
        // If it is a user, remove from users by connection list
        let userId = usersByConnection[connection.id];
        if (userId) {
            delete usersByConnection[connection.id];
            let userConnections = users[userId];
            if (userConnections) {
                // Remove connection from the user's collection
                console.log(`User ${userId} disconnected.`);
                userConnections.forEach( (userConnection, index) => {
                    if (userConnection.id === connection.id){
                        userConnections.splice(index, 1);
                    }
                });
                if (userConnections.length > 0) {
                    console.log(`User ${userId} still has ${userConnections.length} connections.`);
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
        console.log(`User: ${user} connected ${users[user].length} times.`);
    }
}

// Initiate connection to peers
let io = require('socket.io-client');
connectToPeers(config.servers);

// Connect to peer servers
function connectToPeers(servers){
    console.log('Attempting to connect to peers...');
    servers.forEach( peer => {
        if (!peers[peer.id]) {

            // Build host endpoint for peer
            let host = `http://${peer.ip}:${peer.port}`;

            // Attempt connection
            console.log(`Attempt connection to peer: ${peer.id} at: ${host}`);
            let peerSocket = io.connect(host, {reconnection:true} );
            peerSocket.peerId = peer.id;

            // Handle connection success
            peerSocket.on(CONNECT, function() {
                console.log(`Outbound connection to peer: ${this.peerId}`);

                // Store the peer connection
                peers[this.peerId] = peerSocket;

                // Listen for peer disconnection
                peerSocket.on(DISCONNECT, onDisconnect);
            });

            // Peer disconnected
            function onDisconnect(){
                console.log(`Peer: ${this.peerId} disconnected. Will retry automatically.`);
            }
        }
    });
}

