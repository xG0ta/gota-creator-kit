# Gota Creator Kit Legacy (Premiere Pro 2024)

Esta edición CEP es separada de la edición UXP. Está destinada a Premiere Pro
2021 (15.4) hasta 2025.5, incluyendo Premiere Pro 2024 (24.x), donde Adobe
todavía no ofrece las APIs UXP que usa el panel principal.

Funciones incluidas en el panel Legacy:

- Biblioteca local con varias carpetas raíz, búsqueda y vista previa básica.
- Importar y colocar archivos en el cabezal de reproducción sin sobrescribir
  clips que ya estén en la pista.
- Verificación del motor local instalado por Gota Creator Kit.

La automatización avanzada de reencuadre, eliminación de silencios y subtítulos
editables se distribuye en la edición UXP para Premiere 25.6 o posterior. No se
declara compatibilidad falsa con 2024: esos flujos dependen de las APIs nuevas
de Adobe (`premierepro`, transacciones y `SequenceEditor`).

## Empaquetado

El instalador debe distribuir esta carpeta como paquete CEP firmado (`.zxp`)
para los hosts `PPRO [24.0,25.5]`. Se debe conservar el CCX/UXP actual para
`PPRO 25.6+`; ambos paquetes pueden coexistir porque tienen IDs distintos.
