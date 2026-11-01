**Gota Subtítulos** es una app aparte del plugin: pone subtítulos animados y un título con IA a tus videos **sin necesitar Premiere**. Todo se procesa en tu computadora.

## Novedades de 1.1.1
- **Más ajustes del estilo:** grosor del contorno, color y difuminado de la sombra, alineación (centro, izquierda, derecha) y animación de entrada (pop, golpe, fundido o sin animación), además de tipografía, tamaño, altura y colores.
- **Mis estilos:** guarda cómo dejaste los subtítulos con un nombre y úsalo después con un clic.
- **Varios videos a la vez:** elige varios clips y la app los transcribe y guarda todos con el mismo estilo, sin revisarlos uno por uno.
- Al volver a abrir la app se conservan tus ajustes.
- Corrige que en Windows la exportación pudiera quedarse trabada.

## Qué hace
- Subtítulos automáticos en español (o inglés) con Whisper local.
- Tres estilos: **Gota Pop** (la palabra que se dice se pinta de color), **Impacto** (recuadro en la palabra que se dice) y **Minimal**.
- Animación de entrada en cada línea.
- **Título con IA local** (Ollama): propone títulos graciosos con gancho para TikTok; eliges uno o lo escribes tú.
- **Emojis** en el título y en los subtítulos.
- Guarda un **MP4** listo para subir, el texto en **SRT** o los subtítulos solos en **MOV transparente** para otros editores.
- Funciona con videos verticales, horizontales y cuadrados. El original nunca se modifica.

## Descargas
| Tu computadora | Archivo |
| --- | --- |
| Windows 10/11 | `GotaSubtitulos-…-Windows.zip` |
| Mac con Intel | `GotaSubtitulos-…-macOS-Intel.zip` |
| Mac con Apple (M1, M2, M3…) | `GotaSubtitulos-…-macOS-AppleSilicon.zip` |

## Cómo abrirla
**Windows:** descomprime el ZIP completo y abre `GotaSubtitulos\GotaSubtitulos.exe`. Si aparece «Windows protegió tu PC», elige *Más información → Ejecutar de todas formas*.

**Mac:** descomprime el ZIP y arrastra *Gota Subtitulos* a Aplicaciones. La primera vez macOS la bloquea porque no está firmada por Apple: ábrela, cierra el aviso, ve a *Configuración del Sistema → Privacidad y seguridad* y pulsa *Abrir de todos modos*.

La app se abre en tu navegador. No tiene ícono en el Dock: se cierra con el botón **Cerrar app** o sola después de 20 minutos sin usarla.

## Para el título con IA
Instala **Ollama** (gratis) desde ollama.com y descarga un modelo una vez. En la Terminal (Mac) o PowerShell (Windows):

```
ollama pull qwen3:4b-instruct
```

Opcional, para que la IA también «vea» el video cuando casi no hay diálogo: `ollama pull qwen3-vl:2b`.

## Bueno saber
- La primera transcripción descarga el modelo de voz (unos 480 MB, una sola vez).
- Los videos terminados se guardan en *Películas/Gota Subtítulos* (Mac) o *Videos\Gota Subtítulos* (Windows).
- Los emojis de bandera y los que combinan varias figuras (familias, tonos de piel) se dibujan como el emoji base.
