import { GX6 } from "haritorax-interpreter";

let gx6 = new GX6();
gx6.startConnection();

setTimeout(() => {
    gx6.stopConnection();
}, 5000);