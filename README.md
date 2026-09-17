# Gota Creator Kit ☔

Herramientas para Adobe Premiere Pro: reencuadre automático, edición de silencios, biblioteca local y subtítulos animados.

> Este repositorio muestra únicamente la versión actual para evitar confusiones. Las versiones anteriores están en los Releases de GitHub y no se recomiendan para instalaciones nuevas.

## Descarga correcta — versión 3.2.85

| Tu computadora | Descarga esto | Importante |
| --- | --- | --- |
| **Windows** | [Instalador completo para Windows — GotaCreatorKit-3.2.85-Windows.exe](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.85/GotaCreatorKit-3.2.85-Windows.exe) | Recomendado. Instala el panel y el motor local. |
| **Premiere 2026 sin Creative Cloud** | [Panel directo .ccx — GotaCreatorKit-Premiere-2026-3.2.85.ccx](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.85/GotaCreatorKit-Premiere-2026-3.2.85.ccx) | Instálalo mediante un gestor compatible con CCX. En Windows, ejecuta además el instalador completo para contar con el motor local. |
| **Windows: instalación manual** | [Paquete manual ZIP](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.85/GotaCreatorKit-3.2.85-Windows-Instalacion-Manual.zip) | Incluye el EXE, CCX, ZXP Legacy y guía de respaldo. |
| **macOS** | [Instalador completo para macOS — GotaCreatorKit-3.2.85-macOS.zip](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.85/GotaCreatorKit-3.2.85-macOS.zip) | Descomprime el ZIP completo, instala el CCX dentro de `payload` y abre **Instalar Gota Creator Kit.app**. |
| **Premiere Pro 2021–2025.5** | [Gota Creator Kit Legacy 3.2.85 — ZXP firmado](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.85/GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-3.2.85.zxp) | Para Premiere 2024 y anteriores. Instálalo con ZXP Installer. |

## Novedades de 3.2.85

- La vista previa de subtítulos ahora intenta cargar las fuentes instaladas por el usuario.
- La muestra refleja color, trazo, sombra y glow sin depender de la herencia de estilos del panel.
- Windows, macOS y Legacy se publican con el mismo número de versión.

## Instalación rápida

### Windows

1. Cierra Premiere Pro.
2. Ejecuta `GotaCreatorKit-3.2.85-Windows.exe`.
3. Abre Premiere y entra a **Ventana > Plugins de UXP > Gota Creator Kit**.

### macOS

1. Cierra Premiere Pro.
2. Descarga y descomprime por completo el ZIP.
3. En `payload`, instala `Gota Creator Kit.ccx`.
4. Abre `Instalar Gota Creator Kit.app`. Si macOS lo bloquea, usa clic derecho > **Abrir** y confirma en Privacidad y seguridad.
5. Reinicia Premiere y abre **Ventana > Plugins de UXP > Gota Creator Kit**.

### Premiere 2024 y anteriores

Instala el archivo ZXP mediante ZXP Installer. Esta edición Legacy está destinada a Premiere Pro 2021 (15.4) hasta 2025.5.
