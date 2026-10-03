using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

// Source-only Windows helper. No clipboard API is called until this executable
// is deliberately built and invoked by an opted-in companion. Text stays on
// stdin/stdout; no clipboard value is placed in process arguments or logs.
internal static class Program
{
    private const uint CfUnicodeText = 13;
    private const uint GmemMoveable = 0x0002;
    private const int MaxUtf8Bytes = 65536;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName,
        uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetClipboardSequenceNumber();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern UIntPtr GlobalSize(IntPtr memory);

    private static int Fail(string code, int exit = 2) { Console.WriteLine(JsonSerializer.Serialize(new { error = code })); return exit; }
    private static void Emit(object result) => Console.WriteLine(JsonSerializer.Serialize(result));

    [STAThread]
    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return Fail("unsupported_platform");
        if (args.Length is not (1 or 2) || args[0] is not ("read" or "write")) return Fail("invalid_arguments");
        if (args[0] == "read" && args.Length != 1) return Fail("invalid_arguments");
        if (args[0] == "write" && (args.Length != 2 || !uint.TryParse(args[1], out _))) return Fail("invalid_arguments");

        string? value = null;
        if (args[0] == "write")
        {
            using var input = Console.OpenStandardInput();
            using var buffer = new MemoryStream();
            var chunk = new byte[4096];
            while (true)
            {
                int count = input.Read(chunk, 0, chunk.Length);
                if (count == 0) break;
                if (buffer.Length + count > MaxUtf8Bytes) return Fail("invalid_size");
                buffer.Write(chunk, 0, count);
            }
            if (buffer.Length == 0) return Fail("invalid_size");
            try { value = StrictUtf8.GetString(buffer.ToArray()); }
            catch (DecoderFallbackException) { return Fail("invalid_utf8"); }
            if (value.Contains('\0')) return Fail("unsupported_clipboard_text");
        }

        // An owned hidden window is required: OpenClipboard(NULL), followed by
        // EmptyClipboard, can make SetClipboardData fail per Microsoft docs.
        IntPtr window = CreateWindowExW(0, "STATIC", "", 0, 0, 0, 0, 0,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) return Fail("native_adapter_failed");
        try
        {
            if (!OpenClipboard(window)) return Fail("permission_denied");
            try { return args[0] == "read" ? Read() : Write(uint.Parse(args[1]), value!); }
            finally { CloseClipboard(); }
        }
        finally { DestroyWindow(window); }
    }

    private static int Read()
    {
        uint revision = GetClipboardSequenceNumber();
        if (revision == 0) return Fail("permission_denied");
        IntPtr memory = GetClipboardData(CfUnicodeText);
        if (memory == IntPtr.Zero) return Fail("unsupported_clipboard_type");
        ulong bytes = GlobalSize(memory).ToUInt64();
        if (bytes < 2) return Fail("unsupported_clipboard_type");
        IntPtr pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero) return Fail("permission_denied");
        try
        {
            // Bound scanning even if a foreign owner supplies malformed data.
            int limit = (int)Math.Min(bytes / 2, MaxUtf8Bytes + 1UL);
            int length = 0;
            while (length < limit && Marshal.ReadInt16(pointer, length * 2) != 0) length++;
            if (length == limit) return Fail(bytes / 2 > MaxUtf8Bytes ? "invalid_size" : "unsupported_clipboard_type");
            string text = Marshal.PtrToStringUni(pointer, length) ?? "";
            byte[] encoded;
            try { encoded = StrictUtf8.GetBytes(text); }
            catch (EncoderFallbackException) { return Fail("invalid_utf8"); }
            if (encoded.Length > MaxUtf8Bytes) return Fail("invalid_size");
            Emit(new { revision, contentBase64 = Convert.ToBase64String(encoded) });
            return 0;
        }
        finally { GlobalUnlock(memory); }
    }

    private static int Write(uint expected, string text)
    {
        // Allocate before changing the clipboard. If allocation fails, leave
        // the user's existing clipboard untouched.
        byte[] encoded = Encoding.Unicode.GetBytes(text + '\0');
        IntPtr memory = GlobalAlloc(GmemMoveable, new UIntPtr((uint)encoded.Length));
        if (memory == IntPtr.Zero) return Fail("native_adapter_failed");
        try
        {
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) return Fail("native_adapter_failed");
            Marshal.Copy(encoded, 0, pointer, encoded.Length);
            GlobalUnlock(memory);
            uint current = GetClipboardSequenceNumber();
            if (current == 0) return Fail("permission_denied");
            if (current != expected) return Fail("concurrent_change", 3);
            if (!EmptyClipboard()) return Fail("permission_denied");
            if (SetClipboardData(CfUnicodeText, memory) == IntPtr.Zero) return Fail("write_failed_after_empty", 4);
            memory = IntPtr.Zero; // Windows owns the memory after success.
            uint revision = GetClipboardSequenceNumber();
            if (revision == 0) return Fail("verification_failed", 4);
            Emit(new { revision });
            return 0;
        }
        finally { if (memory != IntPtr.Zero) GlobalFree(memory); }
    }
}
