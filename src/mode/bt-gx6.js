"use strict";

import { EventEmitter } from "events";

export default class bt_gx6 extends EventEmitter {
    constructor() {
        super();
    }
    
    startConnection() {
        console.log("Connected to bt + gx6");
        this.emit("connected");
    }

    stopConnection() {
        console.log("Connected to bt + gx6");
        this.emit("disconnected");
    }
}

export { bt_gx6 };