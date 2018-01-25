const thingShadow = require('aws-iot-device-sdk').thingShadow;
const cmdLineProcess = require('aws-iot-device-sdk/examples/lib/cmdline');
const isUndefined = require('aws-iot-device-sdk/common/lib/is-undefined');
const { deviceMap } = require('./deviceMap');
const { MqttWorker } = require('./mqtt');
let mqttBroker;

function reportStateWatcher(args) {
   const thingShadows = thingShadow({
      keyPath: args.privateKey,
      certPath: args.clientCert,
      caPath: args.caCert,
      clientId: args.clientId,
      region: args.region,
      baseReconnectTimeMs: args.baseReconnectTimeMs,
      keepalive: args.keepAlive,
      protocol: args.Protocol,
      port: args.Port,
      host: args.Host,
      debug: args.Debug
   });

   const operationTimeout = 10000;
   var currentTimeout = null;
   var stack = [];

   function genericOperation(thingName, operation, state) {
       console.log("Generated State: ", state);
      var clientToken = thingShadows[operation](thingName, state);

      if (clientToken === null) {
         if (currentTimeout !== null) {
            console.log('operation in progress, scheduling retry...');
            currentTimeout = setTimeout(
               function() {
                  genericOperation(thingName, operation, state);
               },
               operationTimeout * 2);
         }
      } else {
         stack.push(clientToken);
      }
   }

   function prepareThingState(thing, state) {
        console.log("Prepare Thing Params: ", thing, state);
        return {
            "state": {
                "reported": state
            }
        };
   }

   function deviceConnect() {
    Object.keys(deviceMap).forEach((key) => {
        let thingName = deviceMap[key].thingName;
        thingShadows.register(thingName, {
            ignoreDeltas: true
         },
         function(err, failedTopics) {
            if (isUndefined(err) && isUndefined(failedTopics)) {
                genericOperation(thingName, 'update', prepareThingState(thingName, deviceMap[key].state.DEFAULT));
            }
         });
    });
   }

   function handleUpdate(eventKey, stateName) {
       if (deviceMap[eventKey]) {
        genericOperation(deviceMap[eventKey].thingName, 'update', prepareThingState(
            deviceMap[eventKey].thingName,
            deviceMap[eventKey].state[stateName]
         ));
        } else {
            console.log(`Device [${eventKey}] - not found in deviceMap list`);
        }
       
   }

   function handleStatus(thingName, stat, clientToken, stateObject) {
      var expectedClientToken = stack.pop();

      if (expectedClientToken === clientToken) {
         console.log('got \'' + stat + '\' status on: ' + thingName);
         console.log('More Info: ', clientToken, stateObject);
      } else {
         console.log('(status) client token mismtach on: ' + thingName);
      }

       console.log('updated state to thing shadow');
       if (currentTimeout === null) {
           currentTimeout = setTimeout(function() {
               currentTimeout = null;
               console.log("Trying to update: ", thingName, stat, stateObject);
           }, 10000);
       }
   }

   function handleDelta(thingName, stateObject) {
       console.log('IMPLEMENT: Delta Received: ' + thingName, stateObject);
   }

   function handleTimeout(thingName, clientToken) {
      var expectedClientToken = stack.pop();

      if (expectedClientToken === clientToken) {
         console.log('timeout on: ' + thingName);
      } else {
         console.log('(timeout) client token mismtach on: ' + thingName);
      }

       genericOperation(thingName, 'update', prepareThingState());
   }

   thingShadows.on('connect', function() {
      console.log('connected to AWS IoT');
      mqttBroker = new MqttWorker(handleUpdate);
   });

   thingShadows.on('reconnect', function() {
      console.log('reconnect');
   });

   thingShadows.on('offline', function() {
      if (currentTimeout !== null) {
         clearTimeout(currentTimeout);
         currentTimeout = null;
      }
      while (stack.length) {
         stack.pop();
      }
      console.log('offline');
   });

   thingShadows.on('error', function(error) {
      console.log('error', error);
   });

   thingShadows.on('message', function(topic, payload) {
      console.log('message', topic, payload.toString());
   });

   thingShadows.on('status', function(thingName, stat, clientToken, stateObject) {
      handleStatus(thingName, stat, clientToken, stateObject);
   });

   thingShadows.on('delta', function(thingName, stateObject) {
      handleDelta(thingName, stateObject);
   });

   thingShadows.on('timeout', function(thingName, clientToken) {
      handleTimeout(thingName, clientToken);
   });

   deviceConnect();
}

module.exports = cmdLineProcess;

if (require.main === module) {
   cmdLineProcess('connect to the AWS IoT service and watch for MQTT events from mqtt.js',
      process.argv.slice(2), reportStateWatcher);
}
