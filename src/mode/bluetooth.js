"use strict";

import { EventEmitter } from "events";

export default class Bluetooth extends EventEmitter {
    constructor() {
        super();
    }
    
    startConnection() {
        console.log("Connected to bluetooth");
        this.emit("connected");
    }

    stopConnection() {
        console.log("Disconnected from bluetooth");
        this.emit("disconnected");
    }
}

export { Bluetooth };