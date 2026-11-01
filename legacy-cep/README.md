# Gota Creator Kit Legacy (Premiere Pro 2024)

Esta edición CEP es separada de la edición UXP. Está destinada a Premiere Pro
2021 (15.4) hasta 2025.5, incluyendo Premiere Pro 2024 (24.x), donde Adobe
todavía no ofrece las APIs UXP que usa el panel principal.

Funciones incluidas en el panel Legacy:

- Biblioteca local con varias carpetas raíz, búsqueda y vista previa básica.
- Importar y colocar archivos en el cabezal de reproducción sin sobrescribir
  clips que ya estén en la pista.
- Subtítulos automáticos (desde 3.3.12): transcribe los clips seleccionados con
  el motor local y coloca cada línea como un MOV transparente ya animado
  (`/v1/caption-clip`, códec Animation), en una pista libre y en la carpeta
  «Gota Subtítulos». No usa keyframes ni las APIs UXP.
- Quitar silencios (desde 3.3.12): analiza los clips con el motor local y arma
  una secuencia NUEVA solo con las partes con voz (`buildWithoutSilences` en
  `jsx/host.jsx`). La secuencia original no se modifica.
- Verificación del motor local instalado por Gota Creator Kit.

El reencuadre automático con detección de caras sigue siendo exclusivo de la
edición UXP para Premiere 25.6 o posterior.

## Empaquetado

El instalador debe distribuir esta carpeta como paquete CEP firmado (`.zxp`)
para los hosts `PPRO [24.0,25.5]`. Se debe conservar el CCX/UXP actual para
`PPRO 25.6+`; ambos paquetes pueden coexistir porque tienen IDs distintos.
