/*
  Gota Creator Kit ☔ — creador de MOGRT "Gota Pop"

  Ejecutar UNA sola vez desde After Effects:
  Archivo > Secuencias de comandos > Ejecutar archivo de secuencia...

  Genera una plantilla original con texto editable, entrada rápida desde abajo
  y un resaltado que recorre las palabras. El MOGRT terminado se empaqueta en
  Gota Creator Kit, así que los usuarios finales no necesitan After Effects.
*/
(function () {
    app.beginUndoGroup("Gota Creator Kit - Gota Pop");
    var etapa = "inicializando";

    function fail(mensaje) { throw new Error(mensaje); }
    function folder(path) {
        var result = new Folder(path);
        if (!result.exists && !result.create()) { fail("No se pudo crear: " + path); }
        return result;
    }
    function addEssential(prop, comp, name) {
        try { prop.addToMotionGraphicsTemplateAs(comp, name); } catch (_) {}
    }
    function propertyByMatch(group, match) {
        for (var i = 1; i <= group.numProperties; i++) {
            if (group.property(i).matchName === match) { return group.property(i); }
        }
        return null;
    }

    try {
        etapa = "creando un proyecto limpio";
        app.newProject();

        etapa = "creando la composición";
        var comp = app.project.items.addComp("Gota Subtitulos Editables", 1920, 1080, 1, 8, 30);
        comp.motionGraphicsTemplateName = "Gota_Subtitulos_Editables";

        etapa = "creando texto";
        var textLayer = comp.layers.addText("ESCRIBE TU SUBTITULO");
        textLayer.name = "Texto editable";
        var textDocumentProperty = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = textDocumentProperty.value;
        doc.font = "Arial-BoldMT";
        doc.fontSize = 92;
        doc.applyFill = true;
        doc.fillColor = [1, 1, 1];
        doc.applyStroke = true;
        doc.strokeColor = [0, 0, 0];
        doc.strokeWidth = 3;
        doc.justification = ParagraphJustification.CENTER_JUSTIFY;
        textDocumentProperty.setValue(doc);
        textLayer.property("ADBE Transform Group").property("ADBE Position").setValue([960, 850]);

        etapa = "animando entrada";
        var transform = textLayer.property("ADBE Transform Group");
        var position = transform.property("ADBE Position");
        var scale = transform.property("ADBE Scale");
        position.setValueAtTime(0, [960, 950]);
        position.setValueAtTime(0.08, [960, 840]);
        position.setValueAtTime(0.15, [960, 850]);
        scale.setValueAtTime(0, [58, 58]);
        scale.setValueAtTime(0.08, [110, 110]);
        scale.setValueAtTime(0.15, [100, 100]);
        // No aplicamos setTemporalEaseAtKey: algunas ediciones de AE tratan
        // Scale como una propiedad de tres dimensiones y rechazan arreglos de
        // dos valores. Los fotogramas mantienen el pop rápido y compatible.

        etapa = "creando el resaltado por palabra";
        var animators = textLayer.property("ADBE Text Properties").property("ADBE Text Animators");
        var animator = animators.addProperty("ADBE Text Animator");
        animator.name = "Gota Pop - palabra destacada";
        var animatorProps = animator.property("ADBE Text Animator Properties");
        var fill = animatorProps.addProperty("ADBE Text Fill Color");
        fill.setValue([0.1, 0.72, 1.0]);
        var animatorScale = animatorProps.addProperty("ADBE Text Scale 3D");
        animatorScale.setValue([115, 115, 100]);
        var selectors = animator.property("ADBE Text Selectors");
        var selector = selectors.addProperty("ADBE Text Selector");
        selector.name = "Resaltado en recorrido";
        // El selector trabaja por ÍNDICE DE PALABRA, no por caracteres. Así
        // el color salta de una palabra completa a la siguiente, sin barrer
        // letras ni deslizar una franja entre ellas.
        var advanced = selector.property("ADBE Text Range Advanced");
        advanced.property("ADBE Text Range Units").setValue(2); // Índice
        advanced.property(2).setValue(3); // Basado en: palabras
        advanced.property("ADBE Text Selector Smoothness").setValue(0);
        var selectorStart = propertyByMatch(selector, "ADBE Text Index Start");
        var selectorEnd = propertyByMatch(selector, "ADBE Text Index End");
        if (!selectorStart || !selectorEnd) { fail("No se pudo crear el selector de palabras."); }
        // La duración llega desde Gota Creator Kit para que el resaltado no
        // termine siempre a los 0.62 s: recorre cada frase al ritmo real que
        // Whisper detectó en el audio.
        var controls = textLayer.property("ADBE Effect Parade");
        var durationControl = controls.addProperty("ADBE Slider Control");
        durationControl.name = "Duración del subtítulo";
        durationControl.property(1).setValue(2);
        var activeWord = 'var words=thisLayer.text.sourceText.toString().replace(/^\\s+|\\s+$/g, "").split(/\\s+/); var p=linear(time,0.08,effect("Duración del subtítulo")(1),0,words.length-1); Math.floor(Math.max(0,Math.min(words.length-1,p)))';
        selectorStart.expression = activeWord + ' + 1';
        selectorEnd.expression = activeWord + ' + 2';

        etapa = "exponiendo controles editables";
        addEssential(textDocumentProperty, comp, "Texto editable");
        addEssential(durationControl.property(1), comp, "Duración del subtítulo");

        etapa = "guardando proyecto";
        var destination = folder(Folder.myDocuments.fsName + "/Gota Creator Kit/Templates");
        var projectFile = new File(destination.fsName + "/Gota_Subtitulos_Editables.aep");
        app.project.save(projectFile);

        etapa = "exportando plantilla";
        if (!comp.exportAsMotionGraphicsTemplate(true, destination.fsName)) {
            fail("After Effects no pudo exportar el MOGRT.");
        }
        alert("Plantilla Gota Pop creada.\n\n" + destination.fsName + "\n\nVuelve a Gota Creator Kit para empaquetarla.");
    } catch (error) {
        alert("No se pudo crear la plantilla durante: " + etapa + ".\n\nDetalle: " + error.toString());
    } finally {
        app.endUndoGroup();
    }
})();
