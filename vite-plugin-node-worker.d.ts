declare module "*?nodeWorker" {
    const worker: any;
    export default worker;
}
declare module "./index.js" {
    const exported: any;
    export = exported;
}