import tkinter as tk
from tkinter import filedialog, messagebox
import os
from data_manager import process_tridge_files


class TridgeApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Tridge Data Analysis Tool")
        self.root.geometry("600x450")

        # Instruction Label
        instruction_text = "여러 개의 트릿지 엑셀 파일을 선택해주세요.\n(주의: 이미 분석된 파일이나 날짜가 없는 파일은 업로드하지 마세요.)"
        self.lbl_instruction = tk.Label(
            root, text=instruction_text, justify="center", wraplength=550
        )
        self.lbl_instruction.pack(pady=20)

        # File Selection Frame
        self.frame_files = tk.Frame(root)
        self.frame_files.pack(pady=10, fill="both", expand=True, padx=20)

        # Select Button
        self.btn_select = tk.Button(
            self.frame_files, text="파일 선택 (여러 개 가능)", command=self.select_files
        )
        self.btn_select.pack(anchor="w")

        # Listbox to show selected files
        self.list_files = tk.Listbox(self.frame_files, selectmode=tk.MULTIPLE)
        self.list_files.pack(fill="both", expand=True, pady=5)

        # Scrollbar for listbox
        self.scrollbar = tk.Scrollbar(self.list_files)
        self.scrollbar.pack(side="right", fill="y")
        self.list_files.config(yscrollcommand=self.scrollbar.set)
        self.scrollbar.config(command=self.list_files.yview)

        # Process Button
        self.btn_process = tk.Button(
            root,
            text="파일 처리 및 저장",
            command=self.run_process,
            state="disabled",
            bg="#e1e1e1",
        )
        self.btn_process.pack(pady=20, ipadx=20, ipady=5)

        # Status Label
        self.lbl_status = tk.Label(root, text="대기 중...", fg="gray")
        self.lbl_status.pack(pady=10)

        self.selected_files = []

    def select_files(self):
        files = filedialog.askopenfilenames(
            title="엑셀 파일 선택",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")],
        )
        if files:
            self.selected_files = list(files)
            self.list_files.delete(0, tk.END)
            for f in self.selected_files:
                self.list_files.insert(tk.END, f)

            self.btn_process.config(state="normal", bg="#4CAF50", fg="white")
            self.lbl_status.config(
                text=f"{len(files)}개 파일이 선택되었습니다.", fg="blue"
            )
        else:
            pass

    def run_process(self):
        if not self.selected_files:
            messagebox.showwarning("주의", "처리할 파일을 먼저 선택해주세요.")
            return

        # Ask for output directory
        output_dir = filedialog.askdirectory(title="결과물을 저장할 폴더를 선택하세요")
        if not output_dir:
            return

        self.lbl_status.config(text="처리 중...", fg="orange")
        self.root.update()

        try:
            # Run processing via shared module
            result = process_tridge_files(self.selected_files, output_dir)

            result_msg = (
                f"성공!\n\n파일이 저장되었습니다:\n"
                f"1. {os.path.basename(result['raw_path'])}\n"
                f"2. {os.path.basename(result['analyzed_path'])}\n\n"
                f"저장 위치: {output_dir}\n"
                f"처리된 파일 수: {result['total_files']}\n"
                f"총 데이터 행: {result['total_rows']}"
            )

            self.lbl_status.config(text="처리 완료!", fg="green")
            messagebox.showinfo("완료", result_msg)

        except Exception as e:
            error_msg = f"처리 중 오류가 발생했습니다:\n{str(e)}"
            self.lbl_status.config(text="오류 발생", fg="red")
            messagebox.showerror("오류", error_msg)


if __name__ == "__main__":
    root = tk.Tk()
    app = TridgeApp(root)
    root.mainloop()
