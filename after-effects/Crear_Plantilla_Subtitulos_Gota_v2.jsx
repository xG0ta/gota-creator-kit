/*
  Gota Creator Kit ☔ — plantilla ORIGINAL de subtítulos v2

  Ejecutar UNA vez desde After Effects:
  Archivo > Secuencias de comandos > Ejecutar archivo de secuencia...

  Esta fuente no utiliza recursos de terceros. Exporta una MOGRT propia con:
  texto editable, tamaño, color, trazo, sombra, glow y Gota Pop por palabra.
  Después de exportarla, los usuarios de Premiere solamente necesitan el MOGRT;
  no necesitan tener After Effects instalado.
*/
(function () {
    app.beginUndoGroup("Gota Creator Kit - Plantilla de subtitulos v2");
    var etapa = "inicializando";
    var controlesNoExpuestos = [];
    var controlesExpuestos = [];

    function fail(mensaje) { throw new Error(mensaje); }
    function folder(path) {
        var result = new Folder(path);
        if (!result.exists && !result.create()) { fail("No se pudo crear: " + path); }
        return result;
    }
    function expose(prop, comp, name) {
        // addToMotionGraphicsTemplateAs puede devolver false sin lanzar una
        // excepción. Antes lo tratábamos como éxito, por eso el MOGRT parecía
        // correcto pero no incluía los controles de estilo.
        try {
            comp.openInViewer();
            if (typeof prop.canAddToMotionGraphicsTemplate === "function" && !prop.canAddToMotionGraphicsTemplate(comp)) {
                controlesNoExpuestos.push(name + " (AE no lo admite)");
                return false;
            }
            var result = prop.addToMotionGraphicsTemplateAs(comp, name);
            if (result === false) {
                controlesNoExpuestos.push(name + " (AE devolvió false)");
                return false;
            }
            controlesExpuestos.push(name);
            return true;
        } catch (error) {
            controlesNoExpuestos.push(name + " (" + error.toString() + ")");
            return false;
        }
    }
    function slider(effects, name, value) {
        var control = effects.addProperty("ADBE Slider Control");
        control.name = name;
        control.property(1).setValue(value);
        return control.property(1);
    }
    function color(effects, name, value) {
        var control = effects.addProperty("ADBE Color Control");
        control.name = name;
        control.property(1).setValue(value);
        return control.property(1);
    }
    function checkbox(effects, name, value) {
        var control = effects.addProperty("ADBE Checkbox Control");
        control.name = name;
        control.property(1).setValue(value ? 1 : 0);
        return control.property(1);
    }
    function controlValue(effects, name) {
        // addProperty invalida referencias anteriores en After Effects. Nunca
        // conserves la propiedad retornada al crearla: búscala por nombre una
        // vez terminada la lista completa de efectos.
        var control = effects.property(name);
        if (!control) { fail("No se encontró el control: " + name); }
        return control.property(1);
    }
    function docExpression(sourceName, controllerName) {
        return 'var d=thisComp.layer("' + sourceName + '").text.sourceText;\n' +
            'var c=thisComp.layer("' + controllerName + '");\n' +
            'd.fontSize=c.effect("Tamaño del texto")(1);\n' +
            'd.applyFill=true; d.fillColor=c.effect("Color del texto")(1);\n' +
            'd.applyStroke=true; d.strokeColor=c.effect("Color del trazo")(1);\n' +
            'd.strokeWidth=c.effect("Grosor del trazo")(1);\n' +
            'd.justification=ParagraphJustification.CENTER_JUSTIFY;\n' +
            'd;';
    }
    function writeReport(destination) {
        var report = new File(destination.fsName + "/Gota_Subtitulos_v2_controles.txt");
        if (report.open("w")) {
            report.writeln("Gota Creator Kit - reporte de plantilla v2");
            report.writeln("Controles expuestos (" + controlesExpuestos.length + "): " + controlesExpuestos.join(", "));
            report.writeln("Controles omitidos (" + controlesNoExpuestos.length + "): " + controlesNoExpuestos.join(", "));
            report.close();
        }
    }

    try {
        etapa = "creando proyecto";
        app.newProject();
        etapa = "creando composicion";
        var comp = app.project.items.addComp("Gota Subtitulos Editables", 1920, 1080, 1, 8, 30);
        comp.motionGraphicsTemplateName = "Gota_Subtitulos_Editables";
        // Hacer activa la composición antes de registrar controles evita un
        // fallo conocido de algunas versiones al exponer Sliders de efectos.
        comp.openInViewer();

        etapa = "creando texto editable";
        var source = comp.layers.addText("ESCRIBE TU SUBTITULO");
        source.name = "Texto editable";
        var sourceText = source.property("ADBE Text Properties").property("ADBE Text Document");
        var sourceDoc = sourceText.value;
        sourceDoc.font = "Arial-BoldMT";
        sourceDoc.fontSize = 92;
        sourceDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
        sourceText.setValue(sourceDoc);
        source.property("ADBE Transform Group").property("ADBE Opacity").setValue(0);
        expose(sourceText, comp, "Texto editable");

        etapa = "creando controlador";
        // Los controles viven en un Null independiente. Así After Effects no
        // los confunde con propiedades dependientes de la capa de texto al
        // construir el panel de Gráficos esenciales.
        var controller = comp.layers.addNull();
        controller.name = "Controles Gota";
        controller.shy = true;
        // Un Null no se renderiza. Lo dejamos habilitado para que todas las
        // versiones de AE acepten sus controles en Gráficos esenciales.
        controller.enabled = true;
        var effects = controller.property("ADBE Effect Parade");

        etapa = "creando controles";
        var render = comp.layers.addText("ESCRIBE TU SUBTITULO");
        render.name = "Subtitulo animado";
        var duration = slider(effects, "Duración del subtítulo", 2);
        var textSize = slider(effects, "Tamaño del texto", 92);
        var textColor = color(effects, "Color del texto", [1, 1, 1, 1]);
        var strokeColor = color(effects, "Color del trazo", [0, 0, 0, 1]);
        var strokeWidth = slider(effects, "Grosor del trazo", 3);
        var shadowColor = color(effects, "Color de sombra", [0, 0, 0, 1]);
        var shadowBlur = slider(effects, "Sombra: suavidad", 5);
        var shadowOffset = slider(effects, "Desplazamiento de sombra", 2);
        var glowColor = color(effects, "Color del glow", [0.1, 0.72, 1, 1]);
        var popActive = checkbox(effects, "Gota Pop activo", true);
        var vertical = slider(effects, "Posición vertical", 70);
        controller.selected = true;
        // Es indispensable volver a obtener cada propiedad aquí: al crear
        // Color/Slider/Checkbox nuevos, AE invalida las referencias previas.
        // Esa era la causa de que solo apareciera Posición vertical.
        expose(controlValue(effects, "Duración del subtítulo"), comp, "Duración del subtítulo");
        expose(controlValue(effects, "Tamaño del texto"), comp, "Tamaño del texto");
        expose(controlValue(effects, "Color del texto"), comp, "Color del texto");
        expose(controlValue(effects, "Color del trazo"), comp, "Color del trazo");
        expose(controlValue(effects, "Grosor del trazo"), comp, "Grosor del trazo");
        expose(controlValue(effects, "Color de sombra"), comp, "Color de sombra");
        expose(controlValue(effects, "Sombra: suavidad"), comp, "Sombra: suavidad");
        expose(controlValue(effects, "Desplazamiento de sombra"), comp, "Desplazamiento de sombra");
        expose(controlValue(effects, "Color del glow"), comp, "Color del glow");
        expose(controlValue(effects, "Gota Pop activo"), comp, "Gota Pop activo");
        expose(controlValue(effects, "Posición vertical"), comp, "Posición vertical");

        etapa = "vinculando estilo de texto";
        var renderText = render.property("ADBE Text Properties").property("ADBE Text Document");
        renderText.expression = docExpression("Texto editable", "Controles Gota");
        var transform = render.property("ADBE Transform Group");
        transform.property("ADBE Position").expression = 'var c=thisComp.layer("Controles Gota"); var y=linear(c.effect("Posición vertical")(1),0,100,970,700); var entrada=easeOut(time,0,0.12,85,0); [960,y+entrada]';

        etapa = "creando entrada";
        var scale = transform.property("ADBE Scale");
        scale.setValueAtTime(0, [68, 68]);
        scale.setValueAtTime(0.06, [108, 108]);
        scale.setValueAtTime(0.12, [100, 100]);

        etapa = "creando Gota Pop por palabra";
        var animators = render.property("ADBE Text Properties").property("ADBE Text Animators");
        var animator = animators.addProperty("ADBE Text Animator");
        animator.name = "Gota Pop - palabra destacada";
        var animatorProperties = animator.property("ADBE Text Animator Properties");
        var fill = animatorProperties.addProperty("ADBE Text Fill Color");
        fill.expression = 'thisComp.layer("Controles Gota").effect("Color del glow")(1)';
        var popScale = animatorProperties.addProperty("ADBE Text Scale 3D");
        // Escalar caracteres dentro del selector hace que las palabras se
        // monten sobre las letras vecinas y parezca que hay otro título atrás.
        // El pop de entrada vive en la capa completa; aquí destacamos solo
        // por color para mantener el texto limpio y legible.
        popScale.setValue([100, 100, 100]);
        // Los animadores de texto aceptan la variante 3D en AE actuales;
        // algunas versiones rechazan "ADBE Text Position". El pequeño
        // desplazamiento es decorativo: si no existe, el pop por escala se
        // mantiene y la plantilla nunca se interrumpe.
        try {
            var popPosition = animatorProperties.addProperty("ADBE Text Position 3D");
            if (popPosition) { popPosition.setValue([0, -12, 0]); }
        } catch (_) {}
        var selectors = animator.property("ADBE Text Selectors");
        var selector = selectors.addProperty("ADBE Text Selector");
        selector.name = "Palabra activa";
        var advanced = selector.property("ADBE Text Range Advanced");
        advanced.property("ADBE Text Range Units").setValue(2);
        advanced.property(2).setValue(3);
        advanced.property("ADBE Text Selector Smoothness").setValue(0);
        var start = selector.property("ADBE Text Index Start");
        var end = selector.property("ADBE Text Index End");
        var activeWord = 'var c=thisComp.layer("Controles Gota"); var w=thisLayer.text.sourceText.toString().replace(/^\\s+|\\s+$/g, "").split(/\\s+/); var i=Math.floor(linear(time,0.06,c.effect("Duración del subtítulo")(1),0,w.length-1)); Math.max(0,Math.min(w.length-1,i))';
        start.expression = 'thisComp.layer("Controles Gota").effect("Gota Pop activo")(1)>0 ? (' + activeWord + '+1) : 0';
        end.expression = 'thisComp.layer("Controles Gota").effect("Gota Pop activo")(1)>0 ? (' + activeWord + '+2) : 0';

        etapa = "creando sombra";
        var shadow = comp.layers.addText("ESCRIBE TU SUBTITULO");
        shadow.name = "Sombra de subtitulo";
        // En AE, moveBefore deja esta capa POR ENCIMA de render. La sombra
        // debe quedar detrás para no tapar ni duplicar visualmente el texto.
        shadow.moveAfter(render);
        var shadowText = shadow.property("ADBE Text Properties").property("ADBE Text Document");
        shadowText.expression = 'var d=thisComp.layer("Texto editable").text.sourceText; var c=thisComp.layer("Controles Gota"); d.fontSize=c.effect("Tamaño del texto")(1); d.applyFill=true; d.fillColor=c.effect("Color de sombra")(1); d.applyStroke=false; d.justification=ParagraphJustification.CENTER_JUSTIFY; d;';
        shadow.property("ADBE Transform Group").property("ADBE Opacity").setValue(42);
        shadow.property("ADBE Transform Group").property("ADBE Position").expression = 'var l=thisComp.layer("Subtitulo animado"); var c=thisComp.layer("Controles Gota"); l.transform.position + [c.effect("Desplazamiento de sombra")(1),c.effect("Desplazamiento de sombra")(1)]';
        var blur = shadow.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
        blur.property(1).expression = 'thisComp.layer("Controles Gota").effect("Sombra: suavidad")(1)';

        etapa = "guardando proyecto";
        var destination = folder(Folder.myDocuments.fsName + "/Gota Creator Kit/Templates");
        app.project.save(new File(destination.fsName + "/Gota_Subtitulos_Editables_v2.aep"));
        etapa = "exportando plantilla";
        if (!comp.exportAsMotionGraphicsTemplate(true, destination.fsName)) {
            fail("After Effects no pudo exportar el MOGRT.");
        }
        writeReport(destination);
        var aviso = "Plantilla v2 creada.\n\n" + destination.fsName + "\n\nCopia Gota_Subtitulos_Editables.mogrt a la carpeta plugin/templates del proyecto antes de empaquetar Gota Creator Kit.";
        if (controlesNoExpuestos.length > 0) {
            aviso += "\n\nAfter Effects omitió estos controles opcionales: " + controlesNoExpuestos.join(", ") + ".\nLa plantilla se exportó de todos modos. Texto editable y la animación siguen disponibles.";
        }
        alert(aviso);
    } catch (error) {
        alert("No se pudo crear la plantilla durante: " + etapa + ".\n\nDetalle: " + error.toString());
    } finally {
        app.endUndoGroup();
    }
})();
