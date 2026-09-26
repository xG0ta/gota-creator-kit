using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using Microsoft.Win32;
using System.Windows.Forms;

internal static class Program
{
    private const string ProductName = "Gota Creator Kit ☔";
    private const string PluginId = "com.autoframe.faces.dev";
    private const string PackageVersion = "3.3.2";
    private static readonly string InstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AutoFrameByGota");
    private static readonly string PythonDir = Path.Combine(InstallDir, "Python");
    private static readonly string PythonExe = Path.Combine(PythonDir, "python.exe");
    private static readonly string PythonwExe = Path.Combine(PythonDir, "pythonw.exe");
    private static readonly string ServiceScript = Path.Combine(
        InstallDir, "service", "run_service.py");
    private static readonly string LogFile = Path.Combine(InstallDir, "installer.log");
    private static readonly string SupervisorLog = Path.Combine(InstallDir, "supervisor.log");
    private static readonly string SupervisorErrorLog = Path.Combine(InstallDir, "supervisor-error.log");

    [STAThread]
    private static async Task Main(string[] args)
    {
        if (args.Contains("--watch", StringComparer.OrdinalIgnoreCase))
        {
            await WatchPremiereAsync();
            return;
        }
        if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
        {
            Uninstall();
            return;
        }

        try
        {
            Directory.CreateDirectory(InstallDir);
            await File.AppendAllTextAsync(LogFile, $"\nInstalacion {DateTime.Now:u}\n");
            StopRunningComponents();
            ExtractPayload();
            if (!File.Exists(PythonExe))
                await InstallPrivatePythonAsync();
            await InstallDependenciesAsync();
            await InstallFaceModelAsync();
            InstallSupervisor();
            if (IsPremiereRunning())
                throw new InvalidOperationException(
                    "Cierra Premiere por completo antes de actualizar el panel. " +
                    "Así se reemplaza la versión anterior sin dejar dos copias activas.");
            await LaunchPluginInstallerAsync();
            ShowMessage(
                "Gota Creator Kit ☔ se instaló correctamente.\n\n" +
                "Adobe abrirá ahora la instalación del plugin. " +
                "El motor se encenderá automáticamente cuando abras Premiere.",
                false);
        }
        catch (Exception error)
        {
            await File.AppendAllTextAsync(LogFile, error + "\n");
            ShowMessage(
                "No se pudo completar la instalación.\n\n" +
                $"Detalle: {error.Message}\n\nRegistro: {LogFile}",
                true);
        }
    }

    private static void StopRunningComponents()
    {
        int currentProcessId = Environment.ProcessId;
        foreach (Process process in Process.GetProcessesByName(
            "Instalar Gota Creator Kit"))
        {
            try
            {
                if (process.Id == currentProcessId) continue;
                process.Kill(true);
                process.WaitForExit(5000);
            }
            catch
            {
                // El proceso pudo terminar entre la busqueda y el cierre.
            }
            finally
            {
                process.Dispose();
            }
        }

        string pidFile = Path.Combine(InstallDir, "service", "autoframe.pid");
        if (!File.Exists(pidFile)) return;
        try
        {
            string text = File.ReadAllText(pidFile).Trim();
            if (!int.TryParse(text, out int processId)) return;
            using Process service = Process.GetProcessById(processId);
            service.Kill(true);
            service.WaitForExit(8000);
        }
        catch
        {
            // Un PID viejo significa que el motor ya estaba detenido.
        }
    }

    private static void ExtractPayload()
    {
        using Stream? source = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("AutoFramePayload");
        if (source is null) throw new InvalidOperationException("Falta el contenido del instalador.");
        using var archive = new ZipArchive(source, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            string archivePath = entry.FullName.Replace('\\', '/');
            if (archivePath.Contains("/__pycache__/", StringComparison.OrdinalIgnoreCase) ||
                archivePath.EndsWith(".log", StringComparison.OrdinalIgnoreCase) ||
                archivePath.EndsWith(".pid", StringComparison.OrdinalIgnoreCase) ||
                archivePath.EndsWith(".sqlite3", StringComparison.OrdinalIgnoreCase))
                continue;
            string destination = Path.GetFullPath(Path.Combine(InstallDir, entry.FullName));
            if (!destination.StartsWith(Path.GetFullPath(InstallDir), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Ruta inválida dentro del instalador.");
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, true);
        }
    }

    private static async Task InstallPrivatePythonAsync()
    {
        string installer = Path.Combine(Path.GetTempPath(), "autoframe-python.exe");
        const string url = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe";
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        await using (var output = File.Create(installer))
        await using (var input = await client.GetStreamAsync(url))
            await input.CopyToAsync(output);

        int code = await RunAsync(installer,
            $"/quiet InstallAllUsers=0 TargetDir=\"{PythonDir}\" " +
            "Include_pip=1 Include_test=0 Include_launcher=0 PrependPath=0");
        File.Delete(installer);
        if (code != 0 || !File.Exists(PythonExe))
            throw new InvalidOperationException($"Python no pudo instalarse (código {code}).");
    }

    private static async Task InstallDependenciesAsync()
    {
        string requirements = Path.Combine(InstallDir, "service", "requirements-installer.txt");
        int code = await RunAsync(PythonExe,
            $"-m pip install --disable-pip-version-check --no-warn-script-location -r \"{requirements}\"");
        if (code != 0)
            throw new InvalidOperationException($"Las dependencias no pudieron instalarse (código {code}).");
    }

    private static async Task InstallFaceModelAsync()
    {
        string modelDir = Path.Combine(InstallDir, "models");
        string modelFile = Path.Combine(
            modelDir, "face_detection_yunet_2023mar.onnx");
        const long expectedModelSize = 232_589;
        if (File.Exists(modelFile) &&
            new FileInfo(modelFile).Length == expectedModelSize)
            return;

        Directory.CreateDirectory(modelDir);
        const string url =
            "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/" +
            "models/face_detection_yunet/face_detection_yunet_2023mar.onnx";
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        await using (var output = File.Create(modelFile))
        await using (var input = await client.GetStreamAsync(url))
            await input.CopyToAsync(output);
        if (new FileInfo(modelFile).Length != expectedModelSize)
            throw new InvalidOperationException(
                "El modelo facial 2.0 no se descargó correctamente.");
    }

    private static void InstallSupervisor()
    {
        string supervisorDir = Path.Combine(InstallDir, "Supervisor");
        Directory.CreateDirectory(supervisorDir);
        string supervisor = Path.Combine(
            supervisorDir, "Instalar Gota Creator Kit.exe");
        string currentExecutable = Environment.ProcessPath
            ?? throw new InvalidOperationException(
                "No se pudo localizar el ejecutable del instalador.");
        File.Copy(currentExecutable, supervisor, true);
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Run");
        key.SetValue("AutoFrameByGota", $"\"{supervisor}\" --watch");
        Process.Start(new ProcessStartInfo(supervisor, "--watch")
        {
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
    }

    private static string? FindAdobePluginInstaller()
    {
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Common Files", "Adobe", "Adobe Desktop Common", "RemoteComponents",
                "UPI", "UnifiedPluginInstallerAgent", "UnifiedPluginInstallerAgent.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Common Files", "Adobe", "Adobe Desktop Common", "RemoteComponents",
                "UPI", "UnifiedPluginInstallerAgent", "UnifiedPluginInstallerAgent.exe")
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private static void EnsureCreativeCloudRunning()
    {
        if (Process.GetProcessesByName("Creative Cloud").Length > 0) return;
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Adobe", "Adobe Creative Cloud", "ACC", "Creative Cloud.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Adobe", "Adobe Creative Cloud", "ACC", "Creative Cloud.exe")
        };
        string? creativeCloud = candidates.FirstOrDefault(File.Exists);
        if (creativeCloud is null) return;
        try
        {
            Process.Start(new ProcessStartInfo(creativeCloud)
            {
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Minimized
            });
        }
        catch
        {
            // Si Creative Cloud no puede abrirse, el respaldo CCX sigue
            // mostrando su instalador al usuario.
        }
    }

    private static async Task LaunchPluginInstallerAsync()
    {
        // Las versiones previas del paquete conservaban espacios en este nombre.
        // Aceptamos ambos formatos para que una actualización nunca falle por el
        // nombre interno del archivo extraído.
        string[] ccxCandidates =
        {
            Path.Combine(InstallDir, "GotaCreatorKit.ccx"),
            Path.Combine(InstallDir, "Gota Creator Kit.ccx")
        };
        string? ccx = ccxCandidates.FirstOrDefault(File.Exists);
        if (string.IsNullOrWhiteSpace(ccx))
            throw new InvalidOperationException("No se encontró el plugin CCX.");

        // La utilidad de Adobe puede devolver éxito aunque Premiere conserve un
        // panel anterior en caché. Instalamos primero la copia exacta incluida
        // en este EXE en la ruta externa de UXP; así EXE y CCX siempre dejan la
        // misma versión disponible, incluso si Creative Cloud no responde.
        InstallPluginDirectly(ccx);

        // Abrir un .ccx con la aplicación predeterminada dejaba instalada una
        // copia anterior en algunos equipos. Usamos UPIA, el instalador oficial
        // de Adobe incluido con Creative Cloud, para reemplazar el panel por la
        // versión incluida en este instalador.
        string? upia = FindAdobePluginInstaller();
        if (!string.IsNullOrWhiteSpace(upia))
        {
            EnsureCreativeCloudRunning();
            // UPIA necesita que Creative Cloud tenga tiempo de iniciar; sin
            // ello puede quedar esperando indefinidamente en segundo plano.
            await Task.Delay(TimeSpan.FromSeconds(4));
            // UPIA no comparte la misma sintaxis en ambos sistemas: Windows
            // requiere /install; --install puede devolver éxito sin instalar.
            CommandResult result = await RunWithOutputAsync(
                upia, $"/install \"{ccx}\"", TimeSpan.FromSeconds(75));
            if (result.ExitCode == 0 && !AdobeReportedFailure(result.Text))
            {
                RemoveOldExternalPluginCopies();
                return;
            }
            await File.AppendAllTextAsync(LogFile,
                "Adobe no confirmó el reemplazo del panel. " +
                $"Código {result.ExitCode}; se abrirá el respaldo CCX.\n");
        }

        Process.Start(new ProcessStartInfo(ccx) { UseShellExecute = true });
    }

    private static void InstallPluginDirectly(string ccx)
    {
        string external = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Adobe", "UXP", "Plugins", "External");
        string destinationRoot = Path.Combine(external, "GotaCreatorKit-current");
        Directory.CreateDirectory(external);

        // Adobe puede conservar una copia anterior con otro nombre de carpeta.
        // Límpialas antes de copiar el paquete actual para evitar que UXP cargue
        // una versión vieja por prioridad o caché.
        RemoveAllExistingPluginCopies(destinationRoot);

        // El destino es fijo y pertenece únicamente a Gota Creator Kit. Al
        // reemplazarlo evitamos que Premiere prefiera una copia anterior.
        if (Directory.Exists(destinationRoot)) Directory.Delete(destinationRoot, true);
        Directory.CreateDirectory(destinationRoot);

        using ZipArchive archive = ZipFile.OpenRead(ccx);
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string destination = Path.GetFullPath(Path.Combine(destinationRoot, entry.FullName));
            if (!destination.StartsWith(destinationRoot + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(destination, destinationRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("El paquete CCX contiene una ruta no válida.");
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, true);
        }
        File.AppendAllText(LogFile,
            $"Panel {PackageVersion} instalado directamente en {destinationRoot}\n");
    }

    private static void RemoveAllExistingPluginCopies(string keepPath)
    {
        string external = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Adobe", "UXP", "Plugins", "External");
        if (!Directory.Exists(external)) return;

        foreach (string folder in Directory.GetDirectories(external))
        {
            if (string.Equals(Path.GetFullPath(folder), Path.GetFullPath(keepPath),
                    StringComparison.OrdinalIgnoreCase))
                continue;

            string manifest = Path.Combine(folder, "manifest.json");
            if (!File.Exists(manifest)) continue;
            try
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(manifest));
                if (!document.RootElement.TryGetProperty("id", out JsonElement idElement) ||
                    !string.Equals(idElement.GetString(), PluginId, StringComparison.OrdinalIgnoreCase))
                    continue;

                Directory.Delete(folder, true);
                File.AppendAllText(LogFile,
                    $"Se eliminó copia anterior del panel antes de instalar: {folder}\n");
            }
            catch (Exception error)
            {
                File.AppendAllText(LogFile,
                    $"No se pudo limpiar copia anterior {folder}: {error.Message}\n");
            }
        }
    }

    private static bool IsPremiereRunning()
    {
        return Process.GetProcesses().Any(process =>
        {
            try { return process.ProcessName.Contains("Premiere", StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        });
    }

    private static bool AdobeReportedFailure(string text)
    {
        return text.Contains("failed to install", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("status = -", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("installation failed", StringComparison.OrdinalIgnoreCase);
    }

    // Una instalación anterior en la carpeta UXP externa puede ganar prioridad
    // sobre el paquete recién instalado. Solo quitamos copias del mismo ID cuya
    // versión sea menor; no tocamos plugins de terceros ni la versión nueva.
    private static void RemoveOldExternalPluginCopies()
    {
        string external = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Adobe", "UXP", "Plugins", "External");
        if (!Directory.Exists(external)) return;

        Version package = Version.Parse(PackageVersion);
        foreach (string folder in Directory.GetDirectories(external))
        {
            string manifest = Path.Combine(folder, "manifest.json");
            if (!File.Exists(manifest)) continue;
            try
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(manifest));
                JsonElement root = document.RootElement;
                string? id = root.TryGetProperty("id", out JsonElement idElement)
                    ? idElement.GetString() : null;
                string? versionText = root.TryGetProperty("version", out JsonElement versionElement)
                    ? versionElement.GetString() : null;
                if (!string.Equals(id, PluginId, StringComparison.OrdinalIgnoreCase) ||
                    !Version.TryParse(versionText, out Version? installed) ||
                    installed >= package)
                    continue;
                Directory.Delete(folder, true);
                File.AppendAllText(LogFile,
                    $"Se eliminó copia anterior del panel: {folder}\n");
            }
            catch (Exception error)
            {
                File.AppendAllText(LogFile,
                    $"No se pudo limpiar copia antigua {folder}: {error.Message}\n");
            }
        }
    }

    private static async Task WatchPremiereAsync()
    {
        Process? service = null;
        Directory.CreateDirectory(InstallDir);
        AppendSupervisorLog($"=== Gota Creator Kit {PackageVersion} watcher ===");
        AppendSupervisorLog($"started={DateTimeOffset.Now:O}; pid={Environment.ProcessId}");
        try
        {
            while (true)
            {
                bool premiereOpen = Process.GetProcesses()
                    .Any(process =>
                    {
                        try { return process.ProcessName.Contains("Premiere", StringComparison.OrdinalIgnoreCase); }
                        catch { return false; }
                    });
                if (premiereOpen && (service is null || service.HasExited))
                {
                    AppendSupervisorLog($"Premiere detectado; iniciando motor: {DateTimeOffset.Now:O}");
                    var start = new ProcessStartInfo(PythonwExe, $"\"{ServiceScript}\"")
                    {
                        WorkingDirectory = InstallDir,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    start.Environment["GOTA_LOG_DIR"] = InstallDir;
                    start.Environment["GOTA_RUN_ID"] = $"win-{DateTime.UtcNow:yyyyMMddTHHmmssZ}-{Environment.ProcessId}";
                    service = Process.Start(start);
                    if (service is null)
                        throw new InvalidOperationException("No se pudo iniciar el motor local.");
                }
                else if (!premiereOpen && service is { HasExited: false })
                {
                    AppendSupervisorLog($"Premiere cerrado; deteniendo motor: {DateTimeOffset.Now:O}");
                    service.Kill(true);
                    service.WaitForExit(5000);
                    service.Dispose();
                    service = null;
                }
                else if (service is { HasExited: true })
                {
                    AppendSupervisorLog($"El motor terminó con código {service.ExitCode}: {DateTimeOffset.Now:O}");
                    service.Dispose();
                    service = null;
                }
                await Task.Delay(2000);
            }
        }
        catch (Exception error)
        {
            AppendSupervisorError(error);
            throw;
        }
    }

    private static void AppendSupervisorLog(string message)
    {
        try { File.AppendAllText(SupervisorLog, message + Environment.NewLine); } catch { }
    }

    private static void AppendSupervisorError(Exception error)
    {
        try
        {
            File.AppendAllText(SupervisorErrorLog,
                $"[{DateTimeOffset.Now:O}] version={PackageVersion}\n{error}\n");
        }
        catch { }
    }

    private static void Uninstall()
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Run");
        key.DeleteValue("AutoFrameByGota", false);
        ShowMessage(
            "Se desactivó el inicio automático. La carpeta puede eliminarse después de cerrar Premiere:\n\n" +
            InstallDir,
            false);
    }

    private sealed record CommandResult(int ExitCode, string Text);

    private static async Task<int> RunAsync(
        string file, string arguments, TimeSpan? timeout = null)
    {
        return (await RunWithOutputAsync(file, arguments, timeout)).ExitCode;
    }

    private static async Task<CommandResult> RunWithOutputAsync(
        string file, string arguments, TimeSpan? timeout = null)
    {
        using var process = Process.Start(new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }) ?? throw new InvalidOperationException($"No se pudo ejecutar {file}.");
        Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();
        Task waitTask = process.WaitForExitAsync();
        if (timeout.HasValue &&
            await Task.WhenAny(waitTask, Task.Delay(timeout.Value)) != waitTask)
        {
            try { process.Kill(true); } catch { }
            await waitTask;
            string timedOutput = await outputTask;
            string timedError = await errorTask;
            await File.AppendAllTextAsync(
                LogFile,
                $"Tiempo agotado al ejecutar {Path.GetFileName(file)}.\n" +
                timedOutput + timedError);
            return new CommandResult(-1, timedOutput + timedError);
        }
        await waitTask;
        string output = await outputTask;
        string error = await errorTask;
        await File.AppendAllTextAsync(LogFile, output + error);
        return new CommandResult(process.ExitCode, output + error);
    }

    private static void ShowMessage(string text, bool error)
    {
        MessageBox.Show(
            text,
            ProductName,
            MessageBoxButtons.OK,
            error ? MessageBoxIcon.Error : MessageBoxIcon.Information);
    }
}
