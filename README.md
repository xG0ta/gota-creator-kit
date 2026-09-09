# Gota Creator Kit ☔

Herramientas para Adobe Premiere Pro: reencuadre automático, edición de silencios, biblioteca local y subtítulos animados.

> Este repositorio muestra únicamente la versión actual para evitar confusiones. Las versiones anteriores están guardadas en `archivos-historicos/` y no se recomiendan para instalaciones nuevas.

## Descarga correcta

| Tu computadora | Descarga esto | Importante |
| --- | --- | --- |
| **Windows** | [Instalador completo para Windows — GotaCreatorKit-3.2.68-Windows.exe](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.68/GotaCreatorKit-3.2.68-Windows.exe) | Ejecuta este archivo. Instala el panel **y** el motor local. |
| **Mac** | [Instalador completo para macOS — GotaCreatorKit-3.2.68-macOS.zip](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.68/GotaCreatorKit-3.2.68-macOS.zip) | Descomprime el ZIP y abre **Instalar Gota Creator Kit.command**. Instala el panel **y** el motor local. |
| **Premiere Pro 2021–2025.5** | [Gota Creator Kit Legacy — instalador CEP firmado](https://github.com/xG0ta/gota-creator-kit/releases/download/v3.2.66-legacy-2024/GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-3.2.66.zxp) | Para Premiere 2024 y anteriores. Instálalo con ZXP Installer. No instales este archivo si tienes Premiere 25.6 o posterior. |

> No descargues un archivo `.ccx` por separado salvo que sepas instalar complementos de Adobe manualmente. El `.ccx` instala únicamente el panel y **no** instala el motor de AutoFrame, subtítulos ni biblioteca.

## Premiere 2024 y anteriores: edición Legacy

Para Premiere Pro **2021 (15.4) hasta 2025.5** instala el archivo
**Gota Creator Kit Legacy** mediante ZXP Installer. Es un panel CEP firmado,
separado del panel UXP moderno y con un ID distinto, por lo que ambos no se
confunden.

La edición Legacy incluye Biblioteca Gota: varias carpetas raíz, búsqueda,
vista previa y colocación segura en la línea de tiempo. Las herramientas que
automatizan la secuencia (reencuadre, silencios y subtítulos) requieren el DOM
UXP oficial de Premiere y continúan disponibles en Premiere **25.6 o superior**.

## Instalación en Windows

1. Cierra Premiere Pro.
2. Descarga y abre **GotaCreatorKit-3.2.68-Windows.exe**.
3. Espera a que termine la instalación.
4. Abre Premiere y ve a **Ventana > Plugins de UXP > Gota Creator Kit**.

## Instalación en macOS

1. Cierra Premiere Pro.
2. Descarga y descomprime **GotaCreatorKit-3.2.68-macOS.zip**.
3. Abre **Instalar Gota Creator Kit.command**. El instalador se encarga de abrir la instalación: no hay que copiar ni escribir comandos. Si macOS lo bloquea, usa clic derecho > **Abrir**.
4. Cuando termine, abre Premiere y ve a **Ventana > Plugins de UXP > Gota Creator Kit**.

El instalador de macOS incluye el servicio local y funciona con Macs Intel y Apple Silicon. Ya no se bloquea por buscar una ruta específica de Premiere: instala el motor local primero y deja que Adobe valide el panel al final. También incluye un respaldo de conexión para validar licencias cuando Python no reconoce los certificados del sistema.

## Actualizaciones

Desde Gota Creator Kit usa **Buscar actualizaciones**. Cuando haya una versión nueva, descarga y ejecuta el instalador completo de tu sistema operativo.

## Ayuda

Instagram: [@Jahir.Emm](https://www.instagram.com/jahir.emm/)
