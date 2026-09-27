# List node processes as "<pid>\t<command line>", one per line.
#
# Used by scripts/local-servers.sh to find local terminal servers on Windows,
# where bash cannot read another process's command line. Kept in its own file so
# the bash side needs no PowerShell quoting gymnastics.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
	$cmd = $_.CommandLine
	if ($null -eq $cmd) { $cmd = '' }
	Write-Output ("{0}`t{1}" -f $_.ProcessId, $cmd)
}
