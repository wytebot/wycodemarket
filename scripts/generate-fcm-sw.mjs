import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";

const firebaseConfig={
  apiKey:"AIzaSyC9_g7DblKRamrFdM2xBKK03Q-MUJM6tt4",
  authDomain:"wycoder.firebaseapp.com",
  projectId:"wycoder",
  storageBucket:"wycoder.firebasestorage.app",
  messagingSenderId:"610749661041",
  appId:"1:610749661041:web:37daf5af5946838914c0d0",
  measurementId:"G-RT3WRQPBL3"
};
const publicDir=join(process.cwd(),"public");
await mkdir(publicDir,{recursive:true});
const config=JSON.stringify(firebaseConfig);
const sw=`/* Generated from the WyCode Firebase Web App configuration. */
importScripts("https://www.gstatic.com/firebasejs/12.2.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.2.1/firebase-messaging-compat.js");
firebase.initializeApp(${config});
const messaging=firebase.messaging();
messaging.onBackgroundMessage((payload)=>{
  const data=payload?.data||{};
  const title=String(data.title||payload?.notification?.title||"New product on WyCode Market");
  const body=String(data.body||payload?.notification?.body||"A new product is available.");
  const url=String(data.url||payload?.fcmOptions?.link||"/");
  self.registration.showNotification(title,{
    body,
    icon:"/icon.png",
    badge:"/icon.png",
    tag:String(data.tag||"wycode-new-product"),
    data:{url}
  });
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=String(event.notification?.data?.url||"/");
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const client of list){
      if("focus" in client){
        try{const u=new URL(target,self.location.origin); if(u.origin===self.location.origin){client.navigate(u.href);} }catch{}
        return client.focus();
      }
    }
    if(clients.openWindow)return clients.openWindow(target);
  }));
});
`;
await writeFile(join(publicDir,"firebase-messaging-sw.js"),sw,"utf8");
console.log("Generated Firebase Messaging service worker with hardcoded public Firebase config.");
