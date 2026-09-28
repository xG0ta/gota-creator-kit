# Gota Creator Kit ☔

Herramientas para Adobe Premiere Pro: reencuadre automático, edición de silencios, biblioteca local y subtítulos animados.

> Este repositorio muestra únicamente la versión actual para evitar confusiones. Las versiones anteriores están en los Releases de GitHub y no se recomiendan para instalaciones nuevas.

## Descarga correcta — versión 3.3.8

| Tu computadora | Descarga esto | Importante |
| --- | --- | --- |
| **Windows** | [Instalador completo para Windows — GotaCreatorKit-3.3.8-Windows.exe](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.3.8/GotaCreatorKit-3.3.8-Windows.exe) | Recomendado. Instala el panel y el motor local. También elimina copias UXP antiguas antes de instalar. |
| **Premiere 2026 sin Creative Cloud** | [ZIP completo: EXE + CCX — GotaCreatorKit-3.3.8-Premiere-2026-sin-Creative-Cloud.zip](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.3.8/GotaCreatorKit-3.3.8-Premiere-2026-sin-Creative-Cloud.zip) | Ejecuta primero el EXE y luego instala el CCX con un gestor compatible. Así también queda instalado el motor local. |
| **macOS** | [Instalador completo para macOS — GotaCreatorKit-3.3.8-macOS.zip](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.3.8/GotaCreatorKit-3.3.8-macOS.zip) | Descomprime el ZIP completo y abre **Instalar Gota Creator Kit.app**. |
| **Premiere Pro 2021–2025.5** | [Gota Creator Kit Legacy 3.3.8 — ZXP](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.3.8/GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-3.3.8.zxp) | Para Premiere 2024 y anteriores. Instálalo con ZXP Installer. |

## Novedades de 3.3.8

- Los subtítulos ya no dependen de MOGRT ni SVG: Premiere recibe PNG transparentes compatibles.
- Los instaladores eliminan copias antiguas de AutoFrame/Gota Creator Kit antes de copiar el panel nuevo.
- Windows, macOS y Legacy comparten exactamente la versión 3.3.8.

- Corrige todos los textos dañados por codificación UTF-8.
- Sustituye las imágenes SVG de subtítulos por PNG transparente compatible con Premiere.
- Alinea el panel, el motor local y los instaladores en la misma versión.

- Corrección de subtítulos: ya no se coloca el MOGRT original con “ESCRIBE TU SUBTÍTULO” cuando Premiere rechaza una copia personalizada. El panel informa el error en vez de ocultarlo y cada gráfico válido conserva el texto transcrito.

- Transcripción local por fragmentos de 90 segundos y consumo de memoria reducido para clips largos; el modelo se reutiliza y se limita a un solo hilo para evitar errores MKL.
- Los errores de transcripción quedan registrados con duración, modelo y archivo para facilitar soporte.

- Subtítulos: nueva plantilla editable con 12 controles, incluyendo texto, tamaño, color, trazo, sombra, glow y posición.
- Se eliminó el duplicado visual fuerte que podía aparecer detrás del texto animado.
- Se invalidó la caché antigua de gráficos para que el texto real de cada subtítulo no sea reemplazado por el marcador.
- Windows, macOS y Legacy se publican con el mismo número de versión.

## Instalación rápida

### Windows

1. Cierra Premiere Pro.
2. Ejecuta `GotaCreatorKit-3.3.8-Windows.exe`.
3. Abre Premiere y entra a **Ventana > Plugins de UXP > Gota Creator Kit**.

### macOS

1. Cierra Premiere Pro.
2. Descarga y descomprime por completo el ZIP.
3. Abre `Instalar Gota Creator Kit.app`; el instalador coloca directamente el panel y el motor local. Si macOS lo bloquea, usa clic derecho > **Abrir** y confirma en Privacidad y seguridad.
5. Reinicia Premiere y abre **Ventana > Plugins de UXP > Gota Creator Kit**.

### Premiere 2024 y anteriores

Instala el archivo ZXP mediante ZXP Installer. Esta edición Legacy está destinada a Premiere Pro 2021 (15.4) hasta 2025.5.
