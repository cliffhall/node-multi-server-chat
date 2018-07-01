// socket-server.js

// Get config file specified on command line
let config;
let path = process.argv[2];
let myId = process.argv[3];
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
    console.log(`My id: ${myId}`);
}

// Splice out the config for this server
let myConfig = config.servers.find(server => server.id === myId);

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
const UPDATE_PEER = 'update_peer';
const UPDATE_CLIENT = 'update_client';

// Connection hashes
let peers = {};
let users = {};
let usersByConnection = {};
let peerUsers = {};

// Listen for clients
let port = myConfig.port;
let socket = require('socket.io')(port);
socket.on(CONNECTION, onConnection);
console.log(`Listening for connections on port: ${port}`);

// Initiate connection to peers
let io = require('socket.io-client');
connectToPeers(config.servers);

// Connect to peer servers
function connectToPeers(servers){
    console.log('Attempting to connect to peers...');
    servers.forEach( peer => {
        if (peer.id !== myId) {

            // Build host endpoint for peer
            let host = `http://${peer.ip}:${peer.port}`;

            // Attempt connection
            console.log(`Attempt connection to peer: ${peer.id} at: ${host}`);
            let peerSocket = io.connect(host, {reconnection:true} );

            // Store the peer connection
            peers[peer.id] = peerSocket;

            // Handle connection success
            peerSocket.on(CONNECT, function() {
                console.log(`Outbound connection to peer: ${peer.id}`);

                // Create the users list for this peer
                peerUsers[peer.id] = [];

                // Listen for peer disconnection
                peerSocket.on(DISCONNECT, onDisconnect);

                // Update the newly connected peer
                updatePeerWithUserList();

            });

            // Peer disconnected
            function onDisconnect(){
                console.log(`Peer: ${peer.id} disconnected. Will retry automatically.`);
            }

            // Update peer with our user list
            function updatePeerWithUserList() {
                let userIds = Object.keys(users);
                if (userIds.length) { // send our list if we have any connections
                    console.log(`Updating peer: ${peer.id} with user list...`);
                    let list = userIds.map(id => ({id: id, connections: users[id].length}));
                    let message = {list: list, peerId:myId};
                    peerSocket.emit(UPDATE_PEER, message);
                }
            }
        }
    });
}

// Handle connection from clients (peers or users)
function onConnection(connection) {

    // Listen for message events
    connection.on(IM, onIm);
    connection.on(IDENT,onIdentify);
    connection.on(DISCONNECT, onDisconnect);
    connection.on(UPDATE_PEER, onUpdatePeer);

    // Handle an identification event from a user
    function onIdentify(userId) {

        // Store the connection for this user
        let user = users[userId];
        if (user){
            user.push(connection);
        } else {
            users[userId] = [connection];
        }
        usersByConnection[connection.id] = userId;

        // Log the new connection and update peers
        reportUserConnections(userId);

        // Send new user list to all the clients (including this one)
        updateClients();
    }

    // Handle an 'im' event from a client
    function onIm(message) {

        console.log(`Received ${message.forwarded?'forwarded ':''}IM from ${message.from} to ${message.to}: ${message.text}`);

        // Send to all recipient connections
        let recipientConnections = users[message.to];
        if (recipientConnections) { // User is connected to this server
            console.log(`Recipient ${message.to} has ${recipientConnections.length} connection${recipientConnections.length>1?'s':''} to this server, sending...`);
            recipientConnections.forEach(userConnection => userConnection.emit(IM, message));
        } else {
            console.log(`Recipient ${message.to} not connected to this server`);
        }

        // Update sender's other connections so all their clients have complete discussion history
        let senderConnections = users[message.from];
        if (senderConnections) { // User is connected to this server
            console.log(`Sender ${message.from} has ${senderConnections.length} connection${senderConnections.length>1?'s':''} to this server, sending...`);
            senderConnections.forEach(senderConnection => senderConnection.emit(IM, message));
        } else {
            console.log(`Sender ${message.from} not connected to this server`);
        }

        // Unless forwarded, forward to all peers with connections for this user
        if (!message.forwarded){
            message.forwarded = true;
            config.servers.forEach( server => {
                let peer = peers[server.id];
                if (peer && peerUsers[server.id].find(u => u.id === message.to)) {
                    console.log(`Forwarding to peer: ${server.id}...`);
                    peer.emit(IM, message);
                } else if (peer && peerUsers[server.id].find(u => u.id === message.from)) {
                    console.log(`Forwarding to peer: ${server.id}...`);
                    peer.emit(IM, message);
                }
            });
        }
    }

    // A peer updated us with info about one or more user connections
    function onUpdatePeer(message) {
        let peerId = message.peerId;
        console.log(`Received update from peer: ${peerId}`);
        if (message.list) { // list of all users, just replace
            console.log(`Replacing user list for peer: ${peerId}`);
            peerUsers[peerId] = message.list;
        } else {
            let user = message.user;
            let users = peerUsers[peerId];
            if (user && user.connections > 0) { // new connection for user
                if (!users.find(u => u.id === user.id)) { // new user
                    console.log(`Adding user ${user.id} to list for peer: ${peerId}`);
                    // add the user to the peer's user list
                    users.push(user);
                } else {
                    // replace user object in peer's user list
                    console.log(`Replacing user ${user.id} in list for peer: ${peerId}`);
                    peerUsers[peerId] = users.map(u => (u.id === user.id) ? user : u);
                }
            } else if (user && user.connections === 0) { // user no longer connected
                // find the user object and remove it from the peer's user list
                console.log(`Removing user ${user.id} from list for peer: ${peerId}`);
                let index = users.findIndex(u => u.id === user.id);
                if (index > -1) users.splice(index,1);
            }
        }

        // Let all the clients know the user list has changed
        updateClients();
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
            reportUserConnections(userId);
            updateClients();
        }

        // Remove listeners
        connection.removeListener(IM, onIm);
        connection.removeListener(IDENT, onIdentify);
        connection.removeListener(DISCONNECT, onDisconnect);
    }

    // Report user connections to console and peers
    function reportUserConnections(user){
        // Report number of connections on console
        let count = users[user] ? users[user].length : 0;
        if (count) console.log(`User: ${user} connected ${count} time${(count>1)?'s':''}.`);

        // Update peers
        console.log(`Updating peers with connection count for user: ${user}...`);
        let message = {
            peerId: myId,
            user: {
                id: user,
                connections: count
            }
        };
        config.servers.forEach( server => {
            let peer = peers[server.id];
            if (peer) peer.emit(UPDATE_PEER, message);
        });
    }

}

// Update clients with user list
function updateClients(){
    console.log(`Updating clients with new user list...`);
    let message = {
        list: getSystemUserList()
    };
    Object.keys(users).forEach(user =>
        users[user].forEach(connection =>
            connection.emit(UPDATE_CLIENT, message)
        )
    );
}

function getSystemUserList(){
    let usersHash = Object.assign({}, users);
    Object.keys(peerUsers).forEach( peerId => {
        peerUsers[peerId].forEach( user => usersHash[user.id] = true);
    });
    let uniqueUsers = Object.keys(usersHash);
    uniqueUsers.sort();
    return uniqueUsers;
}