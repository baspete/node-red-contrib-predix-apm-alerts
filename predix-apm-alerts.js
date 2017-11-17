
const request = require('request');

module.exports = function(RED){
  'use strict';

  // ******************************************************************
  // Config Node

  function apmAlertsNode(n){

    RED.nodes.createNode(this,n);
    var node = this;

    node.on('close', function(){
      /* nothing for now */
    });
  }

  RED.nodes.registerType('predix-apm-alerts', apmAlertsNode, {
    credentials: {
      clientID:{type:'text'},
      clientSecret: { type:'text'}
    }
  });

  // Config Node
  // ******************************************************************

  // ******************************************************************
  // Ingest Node

  function apmAlertsIngestNode(config){
    RED.nodes.createNode(this,config);
    let node = this;
    node.server = RED.nodes.getNode(config.server);
    node.baseUrl = 'https://apm-gateway-svc-rc.int-app.aws-usw02-pr.predix.io';

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
      node.on('alertsStaged', (response) => {
        node.log('Alerts Staged: ' + response.statusCode + ', ' + response.body.uuid);
        node.status({fill:'blue',shape:'dot',text:'Alerts Staged'});
      });
      node.on('alertsCreated', (response) => {
        node.log('Alerts Created: ' + response.statusCode + ', ' + response.body.uuid);
        node.status({fill:'green',shape:'dot',text:'Authenticated'});
      });
      node.on('responseError', (response) => {
        node.error('Response Error: ' + response.statusCode + ': ' + response.body);
        node.status({fill:'red',shape:'dot',text:'Response Error'});
      });
    } else {
      node.status({fill:'yellow', shape:'dot',text:'Missing server config'});
    }

    // Utility method to call alerts service for both ingest and status
    function callAlertsService(node, params){
      params.json = true;
      params.headers = {
        'Authorization': `Bearer ${node.accessToken}`,
        'tenant': '598b0ad5-1241-4422-b9c5-36bb38161949',
        'Content-Type': 'application/json'
      }
      params.url = `${node.baseUrl}/v1/jobs`;
      if(params.method === 'GET'){
        url += `/v1/jobs/${params.uuid}/status`;
        delete params.data;
        delete params.headers['Content-Type'];
      }

      return new Promise((resolve, reject) => {
        request(params, (err, response, body) => {
          if(err){
            node.emit('requestError', err);
            reject(err);
          } else if(response){
            if (response.statusCode < 200 || response.statusCode >= 300){
              node.emit('responseError', response);
              console.log('response error', response.statusCode, response.body);
              reject(err);
            } else {
              resolve(response);
            }
          }
        });
      });
    };

    // Get an ingest token on startup
    request.post({
      url: 'https://d1730ade-7c0d-4652-8d44-cb563fcc1e27.predix-uaa.run.aws-usw02-pr.ice.predix.io/oauth/token',
      auth: {
        'user': 'ingestor.496bb641-78b5-4a18-b1b7-fde29788db38.991e5c23-3e9c-4944-b08b-9e83ef0ab598' // ClientID
      },
      form: {
        'grant_type': 'password',
        'username': '598b0ad5-1241-4422-b9c5-36bb38161949_ingestor', // Ingestion URL
        'password': 'Bethany1' // Ingestion Password
      }
    }, (err, response, body) => {
      if(err){
        console.log('token err', err);
        node.emit('unauthenticated', err);
      } else {
        const r = JSON.parse(body);
        node.accessToken = r.access_token;
        node.emit('authenticated','');
      }
    });

    // Handle data input
    node.on('input', function(msg){
      if(node.accessToken){
        let data;

        // Sanity Check
        if (msg.payload && msg.payload.taskList){
          try {
            data = msg.payload
          } catch (err) {
            node.emit('badPayload', err, msg.payload);
            return;
          }
        }

        // Send the payload to the alerts service
        let params = {
          method: 'POST',
          body: data
        };
        callAlertsService(node, params).then((response) => {
          node.emit('alertsStaged', response);
          const uuid = response.body.uuid;
          node.send({payload:uuid});
        }).catch((err) => {
          node.send({payload:err});
        });

      } else {
        console.log('No access token, no alerts for you!')
      }

    });

  }
  RED.nodes.registerType('predix-apm-alerts-ingest', apmAlertsIngestNode);

  // Ingest
  // ******************************************************************

}
