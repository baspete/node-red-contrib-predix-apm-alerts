
const request = require('request');

module.exports = function(RED){
  'use strict';

  // ******************************************************************
  // Config Node

  function apmAlertsNode(n){

    RED.nodes.createNode(this,n);
    var node = this;
    node.config = Object.assign({}, n, node.credentials);

    node.on('close', function(){
      /* nothing for now */
    });
  }

  RED.nodes.registerType('predix-apm-alerts', apmAlertsNode, {
    credentials: {
      username:{type:'text'},
      password: { type:'password'}
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

    // Indicator
    if(node.server){
      node.on('authenticated', (response) => {
        node.log('Authenticated');
        node.status({fill:'green',shape:'dot',text:'Authenticated'});
      });
      node.on('unauthenticated', (error) => {
        node.error('Unuthenticated: ' + JSON.stringify(error));
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
      node.on('sendingAlerts', (data) => {
        node.log('Sending Alerts: ' + JSON.stringify(data));
        node.status({fill:'blue',shape:'circle',text:'Transmitting'});
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
        'tenant': node.server.config.tenantId // Tenant UUID
      }
      params.url = node.server.config.ingestionUrl;
      if(params.method === 'GET'){
        params.url += `/${params.uuid}/status`; // get the status of a particular job
        delete params.data;
      }
      return new Promise((resolve, reject) => {
        request(params, (err, response, body) => {
          if(err){
            node.emit('requestError', err);
            reject(err);
          } else if(response){
            if (response.statusCode < 200 || response.statusCode >= 300){
              node.emit('responseError', response);
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
      url: node.server.config.uaaUrl,
      auth: {
        'user': node.server.config.clientId // ClientID
      },
      form: {
        'grant_type': 'password',
        'username': node.server.config.username, // Ingestor Username
        'password': node.server.config.password // Ingestion Password
      }
    }, (err, response, body) => {
      if(err){
        node.emit('unauthenticated', err);
      } else {
        const r = JSON.parse(body);
        node.accessToken = r.access_token;
        node.emit('authenticated',r);
      }
    });

    // Handle data input
    node.on('input', function(msg){
      if(node.accessToken){
        let data, params;
        // Sanity Check
        if (msg.payload && msg.payload.taskList){
          try {
            data = msg.payload
          } catch (err) {
            node.emit('badPayload', err, msg.payload);
            return;
          }
        }
        console.log('sending', data);
        // Send the payload to the alerts service
        params = { method: 'POST', body: data };
        node.emit('sendingAlerts', data);
        callAlertsService(node, params).then((response) => {
          // Monitor for alerts created
          // NOTE: we're polling here because the alerts service doesn't generate an
          //       event when alerts have been ingested and created. When they implement
          //       an event-driven workflow this can get refactored.
          params = { method: 'GET', uuid: response.body.uuid }
          let id = setInterval(check, 500);
          function check() {
            callAlertsService(node, params).then((response) => {
              if(response.body.taskStatusList[0].status === 'COMPLETE'){
                clearInterval(id);
                node.emit('alertsCreated', response);
                node.send({payload: response.body});
              }
            });
          }
        }).catch((err) => {
          node.send({payload:err});
        });
      } else {
        node.error('No access token, no alerts for you!')
      }

    });

  }
  RED.nodes.registerType('predix-apm-alerts-ingest', apmAlertsIngestNode);

  // Ingest
  // ******************************************************************

}
