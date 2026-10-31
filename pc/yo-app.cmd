@rem Yo (PC edition): the yo-app command for PowerShell and Command Prompt. Runs ..\yo-app.ps1 (see pc/README.md).
@rem One line, ending in exit: uninstall deletes this file after it runs, and update replaces it while it runs. No
@rem delayed expansion (it would eat any "!" in the folder or the arguments): "call" reads %%ERRORLEVEL%% again after
@rem PowerShell exits, so the command returns its exit code.
@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\yo-app.ps1" %* & call exit /b %%ERRORLEVEL%%
