
/**
 * Copyright 2013, 2017 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modifications copyright (C) 2017 Sense Tecnic Systems, Inc.
 *
 **/

var request = require('request');
// var ws = require('ws');
const uaa_util = require('predix-uaa-client');
const WebSocketClient = require('websocket').client;
const url = require('url');
const SECONDS_CONVERT_TO_MS = 1000;
const defaultQueryUrlPrefix = 'https://time-series-store-predix.run.aws-usw02-pr.ice.predix.io/v1/';
const defaultWsURL = 'wss://gateway-predix-data-services.run.aws-usw02-pr.ice.predix.io/v1/stream/messages';
const originPath = 'http://localhost/';

module.exports = function(RED){
  'use strict';

  // ******************************************************************
  // Config Node

  function timeseriesClientNode(n){

    RED.nodes.createNode(this,n);
    var node = this;

    node.UAAurl = n.UAAurl;
    node.queryUrlPrefix = (n.queryUrlPrefix === '') ? defaultQueryUrlPrefix : n.queryUrlPrefix;
    node.wsUrl = (n.wsUrl === '') ? defaultWsURL : n.wsUrl;
    node.clientID = node.credentials.clientID;
    node.clientSecret = node.credentials.clientSecret;
    node.predixZoneId = n.predixZoneId;

    //add the oauth endpoint to the UAA host url
    node.UAAurl += '/oauth/token';

    this.on('close', function(){
      /* nothing for now */
    });
  }

  RED.nodes.registerType('predix-ts-client', timeseriesClientNode, {
    credentials: {
      clientID:{type:'text'},
      clientSecret: { type:'text'}
    }
  });

  // Config Node
  // ******************************************************************

  // ******************************************************************
  // Query Node

  function timeseriesQueryNode(config){
    RED.nodes.createNode(this,config);
    var node = this;
    var requestMethod ='';
    node.queryType = config.queryType;
    node.server = RED.nodes.getNode(config.server);

    // Indicator
    if(node.server){
      node.on('authenticated', () => {
        node.status({fill:'green',shape:'dot',text:'Authenticated'});
      });
      node.on('unauthenticated', () => {
        node.status({fill:'red',shape:'dot',text:'Unauthenticated'});
      });
      node.on('badPayload', (payload) => {
        node.error('Bad Payload: ' + payload);
        node.status({fill:'red',shape:'dot',text:'Bad Payload'});
      });
      node.on('requestError', (error) => {
        node.error('Request Error: ' + error);
        node.status({fill:'red',shape:'dot',text:'Request Error'});
      });
      node.on('requestSuccess', (response) => {
        node.log('Request Success: ' + response.statusCode);
        // Blinkenlights
        node.status({fill:'green',shape:'ring',text:'Authenticated'});
        setTimeout(() => { node.status({fill:'green',shape:'dot',text:'Authenticated'}) }, 100);
      });
      node.on('responseError', (response) => {
        node.error('Response Error: ' + response.statusCode + ': ' + response.body);
        node.status({fill:'red',shape:'dot',text:'Response Error'});
      });
    } else {
      node.status({fill:'yellow', shape:'dot',text:'Missing server config'});
    }

    // Method/Routes for query Types
    switch(node.queryType){
      case 'aggregations':
        node.apiEndpoint = node.server.queryUrlPrefix + 'aggregations';
        requestMethod = 'GET';
        break;
      case 'datapoints':
        node.apiEndpoint = node.server.queryUrlPrefix + 'datapoints';
        requestMethod = 'POST';
        break;
      case 'currentDatapoints':
        node.apiEndpoint = node.server.queryUrlPrefix + 'datapoints/latest';
        requestMethod = 'POST';
        break;
      case 'tags':
        node.apiEndpoint = node.server.queryUrlPrefix + 'tags';
        requestMethod = 'GET';
        break;
      default:
        node.apiEndpoint = node.server.queryUrlPrefix;
    };

    // uaa_util will cache token for these credentials and retrieve a refresh token if needed.
    uaa_util.getToken(node.server.UAAurl, node.server.clientID, node.server.clientSecret).then((token) => {
      node.emit('authenticated','');

      // Input message handler
      node.on('input', function(msg){
        let body;
        // Validate iput
        if (msg.hasOwnProperty('payload')){
          try {
            body = JSON.stringify(msg.payload)
          } catch (err) {
            node.emit('badPayload', err, msg.payload);
            return;
          }
        }

        // Send the request
        request({
            url: node.apiEndpoint,
            headers:{
              'predix-zone-id':node.server.predixZoneId,
              'authorization':'Bearer '+token.access_token
            },
            method:requestMethod,
            body:body
          }, function(error, response, body){
          if(error){
            node.emit('requestError', error);
          } else if(response) {
            if (response.statusCode < 200 || response.statusCode >= 300){
              node.emit('responseError', response);
            } else {
              node.emit('requestSuccess', response);
              // Everything worked. Send the response to the output port.
              node.send({payload:response.body});
            }
          }
        });

      });
    }).catch((err) => {
      node.emit('unauthenticated','');
      node.error(err);
    });

  }
  RED.nodes.registerType('predix-ts-query', timeseriesQueryNode);

  // Query Node
  // ******************************************************************

  // ******************************************************************
  // Ingest Node

  function timeseriesIngestNode(config){
    RED.nodes.createNode(this,config);
    let node = this;
    node.socketTimeout = config.socketTimeout;
    const client = new WebSocketClient();

    node.server = RED.nodes.getNode(config.server);

    // Indicator for Events
    if(node.server){
      node.on('authenticated', () =>  {
        node.log('authenticated');
        node.status({fill:'green',shape:'dot',text:'Authenticated'});
      });
      node.on('unauthenticated', () =>  {
        node.log('unauthenticated');
        node.status({fill:'red',shape:'dot',text:'Unauthenticated'});
      });
      node.on('accessTokenError', () =>  {
        node.error('access token error');
        node.status({fill:'red',shape:'dot',text:'Access Error'});
      });
      node.on('connected', () =>  {
        node.log('Websocket Connected');
        node.status({fill:'blue',shape:'dot',text:'Connected'});
      });
      node.on('disconnected', (description) =>  {
        node.log('Websocket Disconnected: ' + description);
        node.status({fill:'green',shape:'dot',text:'Authenticated'});
      });
      node.on('websocketError', (error) =>  {
        node.error('Websocket Error: ' + error);
        node.status({fill:'red',shape:'dot',text:'Websocket Error'});
      });
      node.on('invalidStatusCode', () =>  {
        node.error('Invalid Ingest Status Code');
        node.status({fill:'red',shape:'dot',text:'Ingest Error'});
      });
      node.on('ingestError', (statusCode) =>  {
        node.status({fill:'red',shape:'dot',text:'Ingest Error'});
        node.error('Ingest Error: ' + statusCode);
      });
      node.on('ingestSuccess', (statusCode) => {
        node.log('Ingest Success: ' + statusCode);
        // Blinkenlights
        node.status({fill:'blue',shape:'ring',text:"Connected"});
        setTimeout(() => { node.status({fill:'blue',shape:'dot',text:"Connected"}) }, 100);
      });
    } else {
      node.status({fill:'yellow', shape:'dot',text:'Missing config'});
    }

    client.on('connect', (connection) => {
      node.connection = connection;
      node.emit('connected', '');

      // Handle connection errors
      node.connection.on('error', (error) => {
        node.emit('websocketError', error);
      });

      // Handle data responses.
      // These should look something like { type: 'utf8', utf8Data: '{'statusCode':202,'messageId':'1'}' }
      node.connection.on('message', (data) => {
        let statusCode;
        try {
          statusCode = JSON.parse(data.utf8Data).statusCode;
        } catch (err) {
          node.emit('invalidStatusCode', '');
        }
        if(statusCode < 200 || statusCode >= 300){
          node.emit('ingestError', statusCode);
        } else {
          node.emit('ingestSuccess', statusCode);
        };
      });

      node.connection.on('close', (reasonCode, description) => {
        console.log('closed connection');
        node.emit('disconnected', description);
      });

    });

    // Get a token immediately
    uaa_util.getToken(node.server.UAAurl, node.server.clientID, node.server.clientSecret).then((token) => {
      node.emit('authenticated','');

      // Check for proxy and add tunnel if needed.
      let requestOptions = {};
      if(process.env.https_proxy) {
        const proxy = url.parse(process.env.https_proxy);
        const tunnelingAgent = require('tunnel').httpsOverHttp({
          proxy: {
            host: proxy.hostname,
            port: proxy.port
          }
        });
        node.log('Using Proxy '+ proxy.host);
        requestOptions.agent = tunnelingAgent;
      }

      const headers = {
        'predix-zone-id':node.server.predixZoneId,
        'authorization':'Bearer '+token.access_token,
        'Origin':originPath
      };

      function ensureConnection(node, client){
        return new Promise((resolve, reject) => {
          if(!node.connection) {
            client.connect(node.server.wsUrl, null, originPath, headers, requestOptions);
            client.on('connect', (connection) => {
              resolve();
            });
          } else {
            resolve();
          }
        });
      };

      // Handle data input
      node.on('input', function(msg){

        // Clear any existing timeouts and start a new one
        clearTimeout(node.timeoutFunction);
        node.timeoutFunction = setTimeout(() => {
          node.connection.close();
          delete node.connection;
        }, node.socketTimeout * SECONDS_CONVERT_TO_MS);

        ensureConnection(node, client).then(() => {
          // Parse the payload and send it
          let payload;
          if (msg.hasOwnProperty('payload')) {
            if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
              payload = RED.util.ensureString(msg.payload);
            } else {
              payload = msg.payload;
            }
          }
          if (payload) {
            try {
              node.connection.sendUTF(payload);
            } catch(err){
              node.error(err);
            }
          }
        });
      });

    }).catch((err) => {
      node.emit('unauthenticated','');
      node.error(err);
    });

  }
  RED.nodes.registerType('predix-ts-ingest', timeseriesIngestNode);

  // Ingest
  // ******************************************************************

}
