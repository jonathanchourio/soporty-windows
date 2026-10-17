# Soporty para Windows

App de soporte remoto para que el técnico **vea la pantalla del cliente y, con su
permiso, controle el mouse y el teclado**. Voz y chat incluidos. Se conecta a las
mismas sesiones que la web y la app de Android.

© 2026 Jonathan Josue Chourio Gonzalez

## Compilar el instalador (.exe) sin instalar nada

Igual que la app de Android: GitHub lo compila por ti.

1. En **Actions** del repositorio abre **Compilar Windows → Run workflow** (o se
   ejecuta solo al subir cambios).
2. Tarda unos 10–20 minutos. Al terminar, en **Artifacts** descarga
   `soporty-windows-1.0.N`: es un ZIP con el instalador `Soporty-...-instalador.exe`.
3. Súbelo en **Super admin → App Windows** de Soporty. Los clientes con Windows
   verán «Descargar para Windows» en su página de soporte.

### Dirección del servidor

En `src/app.js`, la constante `DEFAULT_SERVER` apunta a `https://soporty.com`.
Si tu plataforma está en otro dominio, cámbiala con el lápiz ✏️ en GitHub. El
cliente también puede escribir la dirección en «Servidor» la primera vez.

## Cómo funciona para el cliente

1. Abre la app, escribe el código de 9 números y su nombre.
2. Toca **Compartir mi pantalla** y elige «Toda la pantalla».
3. Habla con el técnico; el técnico ve la pantalla en su consola.
4. Si el técnico pide **controlar**, al cliente le aparece un aviso para permitirlo.
   Mientras dura, se ve una **barra roja «Un técnico está controlando tu equipo»**
   siempre encima, con botón **Detener**. El cliente corta cuando quiera.

El control nunca ocurre sin que el cliente lo autorice en esa sesión.

## Firma del instalador (recomendado, opcional)

Sin un certificado de firma de código, Windows muestra «Windows protegió tu PC»
(SmartScreen) al instalar, y algunos antivirus desconfían de las herramientas de
control remoto. Con un certificado EV/OV se elimina ese aviso. Se puede agregar
después al workflow; por ahora el instalador es válido pero sin firmar.

## Detalles técnicos

- **Tauri 2** (Rust + WebView2). La interfaz reusa el motor WebRTC de Soporty.
- **Control:** el navegador no puede mover el mouse ni teclear, así que esa parte
  es nativa en Rust con la librería `enigo`. Solo se aplica mientras el cliente
  tiene el control autorizado; si no, se ignora todo.
- **Protocolo:** el mismo de la web/Android (api/rtc.php, señales hello/ack/desc/
  ice/ctl). La app se autentica con la cabecera `X-Client-Auth`.
- **Requisitos del cliente:** Windows 10/11. El instalador agrega WebView2 si falta.
