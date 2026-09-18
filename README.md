# Gota Creator Kit ☔

Herramientas para Adobe Premiere Pro: reencuadre automático, edición de silencios, biblioteca local y subtítulos animados.

> Este repositorio muestra únicamente la versión actual para evitar confusiones. Las versiones anteriores están en los Releases de GitHub y no se recomiendan para instalaciones nuevas.

## Descarga correcta — versión 3.2.89

| Tu computadora | Descarga esto | Importante |
| --- | --- | --- |
| **Windows** | [Instalador completo para Windows — GotaCreatorKit-3.2.89-Windows.exe](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.89/GotaCreatorKit-3.2.89-Windows.exe) | Recomendado. Instala el panel y el motor local. |
| **Premiere 2026 sin Creative Cloud** | [ZIP completo: EXE + CCX — GotaCreatorKit-3.2.89-Premiere-2026-sin-Creative-Cloud.zip](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.89/GotaCreatorKit-3.2.89-Premiere-2026-sin-Creative-Cloud.zip) | Ejecuta primero el EXE y luego instala el CCX con un gestor compatible. Así también queda instalado el motor local. |
| **macOS** | [Instalador completo para macOS — GotaCreatorKit-3.2.89-macOS.zip](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.89/GotaCreatorKit-3.2.89-macOS.zip) | Descomprime el ZIP completo, instala el CCX dentro de `payload` y abre **Instalar Gota Creator Kit.app**. |
| **Premiere Pro 2021–2025.5** | [Gota Creator Kit Legacy 3.2.89 — ZXP firmado](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.89/GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-3.2.89.zxp) | Para Premiere 2024 y anteriores. Instálalo con ZXP Installer. |

## Novedades de 3.2.89

- El EXE instala directamente la misma copia 3.2.89 del panel incluida dentro del instalador, evitando que Premiere reutilice una versión anterior.
- La vista previa usa un trazo compatible con UXP y ya refleja grosor, sombra, desplazamiento y glow.
- Windows, macOS y Legacy se publican con el mismo número de versión.

## Instalación rápida

### Windows

1. Cierra Premiere Pro.
2. Ejecuta `GotaCreatorKit-3.2.89-Windows.exe`.
3. Abre Premiere y entra a **Ventana > Plugins de UXP > Gota Creator Kit**.

### macOS

1. Cierra Premiere Pro.
2. Descarga y descomprime por completo el ZIP.
3. En `payload`, instala `Gota Creator Kit.ccx`.
4. Abre `Instalar Gota Creator Kit.app`. Si macOS lo bloquea, usa clic derecho > **Abrir** y confirma en Privacidad y seguridad.
5. Reinicia Premiere y abre **Ventana > Plugins de UXP > Gota Creator Kit**.

### Premiere 2024 y anteriores

Instala el archivo ZXP mediante ZXP Installer. Esta edición Legacy está destinada a Premiere Pro 2021 (15.4) hasta 2025.5.
