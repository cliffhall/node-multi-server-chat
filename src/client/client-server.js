// client-server.js

// Serve the client
const express = require('express');
const app = express();
const path = require('path');
const port = 8080;

console.log(`Instant message client server started. http://localhost:${port}/`);

app.get('/', function(req, res) {
    console.log('New client request');
    res.sendFile(path.join(__dirname + '/chat-client.html'));
});

app.listen(port);