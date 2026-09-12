/** YA-owned bootstrap, never supplied by the agent or imported package. */
export const jobLauncher = `
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadLine() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class YAComputerJob {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPtr,Input,Output,Error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(SafeFileHandle job,int info,ref Limits limits,int size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static void Run(string executable,string instance) {
  using(var job=CreateJobObject(IntPtr.Zero,null)) {
   if(job.IsInvalid) throw new Win32Exception();
   var limits=new Limits(); limits.Basic.Flags=0x2000;
   if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits)))) throw new Win32Exception();
   var startup=new Startup();startup.Size=Marshal.SizeOf(typeof(Startup));ProcessInfo info;
   if(!CreateProcess(executable,new StringBuilder(((char)34)+executable+((char)34)+" user --instance "+instance),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,System.IO.Path.GetDirectoryName(executable),ref startup,out info)) throw new Win32Exception();
   try {
    if(!AssignProcessToJobObject(job,info.Process)) throw new Win32Exception();
    if(ResumeThread(info.Thread)==0xffffffff) throw new Win32Exception();
    Console.WriteLine("{"+(char)34+"pid"+(char)34+":"+info.Pid+"}");Console.Out.Flush();
    // EOF means the owning guardian died. The job also closes after an
    // unexpected resident exit, killing its inherited provider descendants.
    Task.Run(()=>{Console.In.ReadLine();job.Dispose();});
    WaitForSingleObject(info.Process,0xffffffff);
   } finally { TerminateProcess(info.Process,1);CloseHandle(info.Thread);CloseHandle(info.Process); }
  }
 }
}
'@
[YAComputerJob]::Run($p.executable,$p.instance)
`;
