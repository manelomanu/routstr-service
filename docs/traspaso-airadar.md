# AIRadar — Documento de traspaso

*Para alguien que no ha visto el código. Estado a 21 de junio de 2026.*

---

## Qué es, en una frase
AIRadar es un **buscador y pasarela de servicios de inteligencia artificial pensado para agentes autónomos** (programas de IA que actúan solos). Un agente entra, encuentra proveedores de IA y modelos, o directamente lanza una consulta de IA, y **paga por uso** — sin crearse cuenta, sin registrarse, sin API key. Lo comparamos con un "Trivago para agentes de IA".

Está vivo en internet ahora mismo: **https://airadar.fyi**.

## Qué hace exactamente
1. **Directorio:** lista proveedores de IA y sus modelos, ordenados por fiabilidad y velocidad.
2. **Pasarela de inferencia:** un agente puede mandar una pregunta a un modelo (de 1.900 disponibles) y paga esa llamada. Nosotros hablamos con el proveedor por detrás.
3. **Inteligencia de red:** qué modelos están de moda, latencias, fiabilidad.
4. **Reputación de agentes** y **análisis de comportamiento** ("agentanalysis"): detectar bots, coordinación, etc. La idea de fondo es ser "el Chainalysis de los agentes" (forense del comportamiento de agentes).
5. **Marketplace:** agentes que ofrecen servicios se listan.
6. **Relay propio de Nostr** (una especie de servidor de mensajería descentralizada) para coordinación, en `relay.airadar.fyi`.
7. **Avales de fiabilidad ("attestations"):** AIRadar firma y publica recomendaciones de qué proveedores son fiables, que otro proyecto (Vokter) consume.
8. Un montón de **utilidades** de pago por uso (datos de cripto, clima, traducción, resúmenes, hashing, etc.).
9. **SDK de Python** publicado: `pip install airadar-sdk`.

## A qué se ha expandido (más allá del directorio inicial)
Empezó como un simple directorio de nodos de la red **Routstr** (proveedores de IA que cobran en Bitcoin). Hoy es bastante más: pasarela de inferencia, inteligencia de red, reputación, análisis de comportamiento de agentes, marketplace, avales firmados, relay propio, SDK, y soporte de **varias formas de pago y varias redes** (no solo Bitcoin). Ya no es "el directorio de Routstr", es una plataforma.

## Cómo se cobra
Dos sistemas, ambos sin cuenta:
- **L402 = Bitcoin por la red Lightning** (pagos en "sats", céntimos de Bitcoin). **Funciona y está probado.**
- **x402 = stablecoins (USDC)**, en las redes Base/Polygon/Arbitrum y Solana. **USDC en Base está probado con un pago real** ($0,01). USDT en redes tipo Ethereum NO funciona (limitación técnica); en Solana sí.
- Precios típicos: ~10 sats / $0,01 por consulta de directorio; 50–1.000 sats por inferencia según el modelo.

**¿Hay wallet conectada?** Sí. Un nodo Lightning propio (Alby Hub) en el servidor recibe los pagos en Bitcoin, y hay wallets de USDC (una de Ethereum y una de Solana) para los pagos en stablecoin.

## Dónde está desplegado
- Servidor **VPS en Hetzner (Núremberg, Alemania)**, Ubuntu.
- Dominio **airadar.fyi** con HTTPS.
- Por dentro: un servidor web (nginx) que pasa al programa (Node.js), más el relay de Nostr propio.
- **Está vivo en internet ahora** — verificado hoy: responde, ~90 funciones montadas y operativas.

## Qué funciona ya
- El servicio entero está en marcha y responde.
- Pagos Bitcoin/Lightning: funcionando de punta a punta.
- Pagos USDC en Base: probados con dinero real.
- Relay propio: en marcha.
- Avales de fiabilidad: publicándose.
- SDK de Python: instalable y usable.
- **Hoy mismo** se publicó el anuncio del servicio en la red Nostr (perfil + anuncio en 5 relays).

## Qué está a medias o pendiente
- **Pagos USDC en Solana:** aún sin probar.
- **Cashu** (un tercer método de pago, dinero electrónico): no empezado.
- **Cobrar por el relay:** diseñado hoy, parte del código escrito, **sin desplegar**.
- **Análisis de comportamiento de agentes:** está construido pero **sin datos reales** que analizar (ver abajo). Hay un rediseño pensado pero no implementado.

## Decisiones importantes y por qué
- **Ser neutral en el pago:** aceptamos tanto a los "maxis" de Bitcoin (Lightning) como a los de stablecoins (USDC). Queremos ser la puerta de entrada agnóstica, no casarnos con una moneda.
- **Sin cuentas ni API keys:** el cliente es un agente autónomo que paga por llamada. Registrarse no tiene sentido para una máquina.
- **Relay propio:** para no depender de terceros en la coordinación y poder monetizarlo.
- **Los avales son de "fiabilidad", no de "confianza/acceso":** deliberadamente separados, para que recomendar a un proveedor como fiable no le dé sin querer acceso a datos privados en el proyecto consumidor (Vokter).
- **Identidad estable en Nostr:** una sola clave fija, nunca autogenerada, porque es el ancla de los avales.

## Qué falta / próximos pasos pensados
1. Probar pagos USDC en Solana.
2. Añadir Cashu como tercer método de pago.
3. Terminar y desplegar el **cobro por el relay** (en curso).
4. **Ligar ese pago a visibilidad en el directorio** — si no, pagar por escribir en el relay no aporta valor real.
5. **Arreglar/llenar el catálogo de proveedores** (es el cuello de botella real, ver abajo).
6. Rediseñar el análisis de agentes para basarlo en el comportamiento, no en la wallet.
7. Cerrar el **PR #210** para aparecer listados en el ecosistema x402 de Coinbase.

## Lo que NO está resuelto / dudas abiertas (sin maquillar)
- **No hay demanda todavía.** En las últimas 24h: ~2.600 peticiones pero **0 pagos y 0 clientes reales**. La mayoría del tráfico son robots de polling y **escáneres de vulnerabilidades** husmeando el servidor. Está todo construido, pero comercialmente no se usa aún.
- **El catálogo de proveedores es delgado y engañoso.** Hay 95 proveedores indexados y 1.900 modelos, pero **93 son de la red AntSeed (no accesibles por web directa, son P2P)**, la red descentralizada Routstr se ha desplomado a 1 (caído), y **realmente usable directo hay ~1** (OpenRouter, que encima pide su propia API key). El valor honesto hoy es la pasarela de inferencia, no "95 proveedores".
- **El análisis de agentes es una catedral sin feligreses:** motor potente, pero sin sujetos reales que analizar mientras no haya tráfico de agentes.
- **El cobro del relay puede quedar cosmético** si no se liga a algo que el cliente valore (visibilidad en el directorio).
- **Detalle técnico sin confirmar:** si el software del relay deja anunciar el "hay que pagar" en su ficha pública; si no, habría que servirlo por otra vía.

## Resumen para el socio que vuelve de vacaciones
La plataforma está **construida y viva**: cobra en Bitcoin y en USDC, tiene pasarela de IA, directorio, relay propio, SDK y avales firmados, todo desplegado y respondiendo. Lo que **falta no es tecnología, es tracción**: no hay clientes pagando todavía, y el catálogo de proveedores reales es flojo. Los próximos pasos sensatos son cerrar los métodos de pago que quedan (Solana, Cashu), monetizar el relay **de forma que valga la pena**, y sobre todo conseguir proveedores de verdad y agentes que paguen. La ingeniería va por delante de la demanda — ese es el reto ahora.
