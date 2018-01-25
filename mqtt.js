const mqtt = require('mqtt');
const { deviceMap } = require('./deviceMap');

const config = Object.assign({
    mqttUrl: 'PUT_YOUR_MQTT_SERVER_ADDRESS',
    boardsChannel: 'wrks_boards',
    sensorsChannel: 'wrks_sensors',
    customSensorsChannelPrefix: 'wrks_sensors/',
    boardTTL: 21000, // NUMBER OF MS, FOR BOARD TIMEOUT
    pingTime: 10000,
    boardStatusTime: 30000,
    messageDelimiter: '::',
    sensorChannelDelimiter: '/'
});

const COMMANDS = Object.assign({
    REGISTER: 'REGISTER',
    PING: 'PING',
    PONG: 'PONG'
});

const database = Object.assign({
    devices: {},
    boards: {}
});

const MqttWorker = function(callback) {
    this.client  = mqtt.connect(config.mqttUrl);

    this.client.on('connect', () => {
        this.client.subscribe(config.boardsChannel);
        this.client.subscribe(config.sensorsChannel);

        this.register();
    });

    this.client.on('message', (topic, message) => {
        const time = new Date();
        const chunks = topic.toString().split(config.sensorChannelDelimiter);

        switch(Array.isArray(chunks) ? chunks[0] : topic.toString()) {
            case config.boardsChannel:
                this.processBoardsMessages(topic, message, time);
                break;
            case config.sensorsChannel:
                this.processSensorsMessages(topic, message, time, Array.isArray(chunks) ? chunks[1] : null, callback);
                break;
            default:
                console.error(`[${time}] UNDEFINED TOPIC: [${topic.toString()}] ${message.toString()}`);
                break;
        }

    });

    setTimeout(this.updateBoardsStatus.bind(this), config.boardStatusTime);
    setTimeout(this.pingBoards.bind(this), config.pingTime);
}

module.exports.MqttWorker = MqttWorker;

MqttWorker.prototype.register = function() {
    this.client.publish(config.boardsChannel, COMMANDS.REGISTER);
}

MqttWorker.prototype.ping = function() {
    this.client.publish(config.boardsChannel, COMMANDS.PING);
}

MqttWorker.prototype.processBoardsMessages = function(topic, message, time) {
    const command = message.toString().split(config.messageDelimiter);

    if (Array.isArray(command) && command.length >= 2) {
        switch(command[0]) {
            case COMMANDS.REGISTER:
                this.registerBoard(topic, command, time);
                break;
            case COMMANDS.PONG:
                this.pongBoard(topic, command, time);
                break;
        }
    } else {
        switch (command.toString()) {
            case COMMANDS.PING:
                console.log(`[${topic}][${time}] => PING`);
                break;
            case COMMANDS.REGISTER:
                console.log(`[${topic}][${time}] => REGISTER`);
                break;
            default:
                console.error(`[${topic}][${time}] => UNDEFINED COMMAND: ${command}`);
                break;
        }
    }
}

MqttWorker.prototype.registerBoard = function(topic, command, time) {
    const devicesToRegister = command.splice(2) || [];
    let backupedDevices = {};
    let customSensorsChannel = config.customSensorsChannelPrefix + command[1];

    if(!database.boards[command[1]]) {
        database.boards[command[1]] = Object.assign({
            registered: 0,
            reconnectCount: -1,
            status: 'offline',
            lastResponse: -1
        });

        this.client.subscribe(customSensorsChannel);
        console.log(`[${topic}][${time}] <= ${command.join(config.messageDelimiter)}`);
        console.log(`[${topic}][${time}] + NEW BOARD REGISTERED: [${command[1]}]`);
        console.log(`[${topic}][${time}] + NEW TOPIC SUBSCRIBED: [${customSensorsChannel}]`);
    } else {
        backupedDevices = database.boards[command[1]].devices;
    }

    const board = database.boards[command[1]];
    board.devices = Object.assign({});
    board.status = 'online';
    board.lastResponse = time;
    board.reconnectCount++;

    devicesToRegister.forEach((device) => {
        if (!device || device == ':') {
            return null;
        }
        board.devices[device] = backupedDevices[device] || this.prepareDeviceObject(device);
        this.client.publish(customSensorsChannel, device + config.messageDelimiter + board.devices[device].status);
    });
}

MqttWorker.prototype.pongBoard = function(topic, command, time) {
    const board = command[1];

    if(database.boards[board]) {
        database.boards[board].status = 'online';
        database.boards[board].lastResponse = time;
        console.log(`[${topic}][${time}] <= PONG: [${board}]`);
    } else {
        console.error(`[${topic}][${time}] <= PONG ERROR. BOARD NOT REGISTERED: [${board}]`);
    }
}

MqttWorker.prototype.processSensorsMessages = function(topic, message, time, board, callback) {
    var command = message.toString().split('::');
    var shouldTriggerUpdate = false;

    if (Array.isArray(command) && command.length === 2) {
        // Check if device exists in database
        if (!database.boards[board].devices[command[0]]) {
            // If not - we do need to create one
            database.boards[board].devices[command[0]] = this.prepareDeviceObject(command[0]);
        }

        // Check if state changed, or sensor just send the same state again
        if (database.boards[board].devices[command[0]].status !== command[1]) {
            shouldTriggerUpdate = true;
        }

        // Update status for the device with data from message
        database.boards[board].devices[command[0]].status = command[1];
        database.boards[board].devices[command[0]].received = time;

        if (shouldTriggerUpdate) {
            console.log(`[${topic}][${time}] <= TRIGGER AWS UPDATE WITH PARAMS: ${command[0]}, ${command[1]}`);
            if (callback) {
                callback(command[0], command[1]);
            }
        }

    }
    console.log(`[${topic}][${time}] <= MESSAGE: ${message.toString()}`);
}

MqttWorker.prototype.prepareDeviceObject = function(device) {
    return Object.assign({
        status: 'INACT',
        received: null
    });
}

MqttWorker.prototype.updateBoardsStatus = function() {
    const timestamp = new Date().getTime();

    Object.keys(database.boards).forEach(function(board) {
        if(timestamp - database.boards[board].lastResponse.getTime() > config.boardTTL) {
            database.boards[board].status = 'offline';
        }
    });

    printBoardsStatus();

    setTimeout(arguments.callee.bind(this), config.boardStatusTime);
}

MqttWorker.prototype.pingBoards = function() {
    this.client.publish(config.boardsChannel, COMMANDS.PING);

    setTimeout(arguments.callee.bind(this), config.pingTime);
}


function printBoardsStatus() {
    var timestamp = new Date().getTime();
    printLine();
    console.log('| Board\t\t| Status\t| Last Pong\t\t| Diff\t| Restart\t| Devices\t|');
    printLine();
    Object.keys(database.boards).forEach(function(board) {
        var diff = Math.floor((timestamp - database.boards[board].lastResponse.getTime()) / 1000);
        diff = diff < 10 ? diff.toString() + '\t' : diff;
        console.log('| ' + board + '\t| '
            + database.boards[board].status + '\t| '
            + database.boards[board].lastResponse.getTime() + '\t| '
            + diff + '\t| '
            + database.boards[board].reconnectCount + '\t\t\t| '
            + Object.keys(database.boards[board].devices).length + '\t\t\t|');
        printDevicesStatus(board);
    });
    printLine();

    function printLine() {
        console.log('+' + Array(72).join("-") + '+');
    }
    function printDevicesStatus(board) {
        console.log(database.boards[board].devices);
    }

}

// const broker = new MqttWorker();