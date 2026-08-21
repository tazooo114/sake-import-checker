import pandas as pd
import datetime
import os
import sys
import glob
import re
import shutil
import tempfile

# Configuration
OUTPUT_DIR = "../data"  # Relative to this script
PRODUCT_COL = "Reported Product Name"
VALUE_COL = "Value"
EXPORTER_COL = "Exporter"
VOLUME_COL = "Volume"
CATEGORY_COL = "Category"
ORIGIN_COUNTRY_COL = "Origin Country"
RAW_IMPORTER_COL = "Raw Importer Name"
HSCODE_COL = "HS-CODE"


def get_input_files():
    """
    Get input files from command line args or interactive selection.
    """
    # 1. Check Command Line Arguments
    if len(sys.argv) > 1:
        files = sys.argv[1:]
        valid_files = [f for f in files if os.path.exists(f) and f.endswith(".xlsx")]
        if valid_files:
            return valid_files
        print("Warning: No valid .xlsx files found in arguments.")

    # 2. Interactive Selection
    current_dir = os.path.dirname(os.path.abspath(__file__))
    all_xy_files = glob.glob(os.path.join(current_dir, "*.xlsx"))

    candidates = []
    for f in all_xy_files:
        basename = os.path.basename(f)
        # Exclude output files if they exist in valid source dir
        if (
            basename.startswith("analyzed_data_")
            or basename.startswith("merged_raw_")
        ):
            continue
        if basename.startswith("~$"):  # Temp files
            continue
        candidates.append(f)

    if not candidates:
        return []

    # Sort candidates alphabetically by basename
    candidates.sort(key=lambda x: os.path.basename(x))

    print("\n[ File Selection ]")
    for idx, f in enumerate(candidates):
        print(f"[{idx + 1}] {os.path.basename(f)}")

    print("\nSelect files to process:")
    print("- Enter numbers separated by space or comma (e.g., '1 3' or '1,3')")
    print("- Press Enter to select ALL files")

    selection = input("Selection > ").strip()

    if not selection:
        return candidates

    selected_files = []
    try:
        # Replace commas with spaces and split
        indices = [int(x) for x in selection.replace(",", " ").split()]
        for i in indices:
            if 1 <= i <= len(candidates):
                selected_files.append(candidates[i - 1])
            else:
                print(f"Warning: Invalid index {i} ignored.")
    except ValueError:
        print("Error: Invalid input format. Using all files.")
        return candidates

    return selected_files


# Helper functions
def safe_save_excel(df, path, sheet_name="Sheet1", index=False, **kwargs):
    """
    Save DataFrame to Excel safely by writing to a temp file first,
    then moving to the destination. This avoids timeout issues on
    network/cloud drives (like iCloud).
    """
    directory = os.path.dirname(path)
    filename = os.path.basename(path)
    
    # Create a temp file in the system temp directory
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp_path = tmp.name
    
    try:
        print(f" ... saving to temp file: {tmp_path}")
        if isinstance(df, pd.DataFrame):
            df.to_excel(tmp_path, sheet_name=sheet_name, index=index, **kwargs)
        else:
            # Assume df is a writer function or we handle specific logic
            # tailored for multiple sheets if needed.
            # For this simple helper, we assume single DF.
            # We will handle the multi-sheet writer separately if needed.
            pass
            
        # Move to final destination
        shutil.move(tmp_path, path)
        print(f"Saved: {path}")
    except Exception as e:
        print(f"Failed to save {path}: {e}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise e

def join_unique(x):
    return ", ".join(sorted(set(x.astype(str))))


def reorder_en_after_kr(df):
    """Ensure 'Product Name (EN)' comes immediately after 'Product Name (KR)'."""
    cols = df.columns.tolist()
    if "Product Name (KR)" in cols and "Product Name (EN)" in cols:
        cols.remove("Product Name (EN)")
        kr_idx = cols.index("Product Name (KR)")
        cols.insert(kr_idx + 1, "Product Name (EN)")
        return df[cols]
    return df


def process_tridge_files(input_files, output_dir):
    """
    Core logic to process Tridge Excel files.
    Args:
        input_files (list): List of file paths to process.
        output_dir (str): Directory to save output files.
    Returns:
        dict: Summary of saved files and counts.
    """
    if not input_files:
        raise ValueError("No input files provided.")

    os.makedirs(output_dir, exist_ok=True)
    print(f"Output Directory: {output_dir}")

    print(f"Processing {len(input_files)} files...")
    all_dfs = []
    for f in input_files:
        try:
            xls = pd.ExcelFile(f)
            # Pick the first sheet whose header row contains the product column
            # (data is not always on the first sheet, e.g. pivot sheets first).
            # Fallback: "Raw data" sheet name pattern, then the first sheet.
            sheet_name = 0
            for sheet in xls.sheet_names:
                header = pd.read_excel(xls, sheet_name=sheet, nrows=0)
                if PRODUCT_COL in header.columns:
                    sheet_name = sheet
                    break
            else:
                for sheet in xls.sheet_names:
                    if re.match(r"^Raw data", sheet, re.IGNORECASE):
                        sheet_name = sheet
                        break
            df = pd.read_excel(xls, sheet_name=sheet_name)

            # Normalize Columns
            if PRODUCT_COL not in df.columns and len(df.columns) > 3:
                df = df.rename(columns={df.columns[3]: PRODUCT_COL})
            if "Origin" in df.columns:
                df = df.rename(columns={"Origin": ORIGIN_COUNTRY_COL})

            all_dfs.append(df)
            print(f" [OK] {os.path.basename(f)} - {len(df):,} rows")
        except Exception as e:
            print(f" [ERROR] {os.path.basename(f)}: {e}")
            # We continue processing other files even if one fails
            continue

    if not all_dfs:
        raise ValueError("No valid data found in the provided files.")

    # 1. Raw Data Concatenation
    raw_concat_df = pd.concat(all_dfs, ignore_index=True)
    print(f"\n[Summary]")
    print(f"Total rows after merging: {len(raw_concat_df):,}")

    today_str = datetime.datetime.now().strftime("%y%m%d")
    raw_path = os.path.join(output_dir, f"raw_data_{today_str}.xlsx")
    
    # Use safe save
    safe_save_excel(raw_concat_df, raw_path, index=False)

    # 2. Cleaning & Processing
    df_processed = raw_concat_df.copy()

    # Drop Unwanted
    cols_to_drop = [
        "HS Code Name",
        "Detailed HS-CODE",
        "Product Description",
        "Import Country",
        "Importer",
        "Currency",
        "Value confimed / estimated?",
        "Volume confirmed / estimated?",
        "Unit",
        "Incoterms",
        "Export Country",
    ]
    df_processed = df_processed.drop(
        columns=[c for c in cols_to_drop if c in df_processed.columns]
    )

    # Drop NaNs
    if {PRODUCT_COL, VALUE_COL}.issubset(df_processed.columns):
        df_processed = df_processed.dropna(subset=[PRODUCT_COL, VALUE_COL])

    # Parse Names: [Category] KR__EN
    df_processed[PRODUCT_COL] = (
        df_processed[PRODUCT_COL]
        .astype(str)
        .str.replace(r"^\[.*?\]", "", regex=True)
        .str.strip()
    )
    split = df_processed[PRODUCT_COL].str.split("__", n=1, expand=True)
    df_processed["Product Name (KR)"] = split[0].str.strip()
    df_processed["Product Name (EN)"] = (
        split[1].str.strip() if len(split.columns) > 1 else ""
    )

    # Aggregation
    if "Date" in df_processed.columns:
        df_processed = df_processed.drop_duplicates()

        # Group keys: KR Name (Primary)
        group_keys = [
            "Date",
            "Product Name (KR)",
            CATEGORY_COL,
            EXPORTER_COL,
            ORIGIN_COUNTRY_COL,
            RAW_IMPORTER_COL,
            HSCODE_COL,
        ]
        group_keys = [k for k in group_keys if k in df_processed.columns]

        # Files merged from different sources may lack some key columns
        # (e.g. no Origin Country / Raw Importer Name); groupby drops rows
        # with NaN keys, so blank them out instead of losing the rows.
        for k in group_keys:
            if k != "Date":
                df_processed[k] = df_processed[k].fillna("")

        measure_agg = {
            k: "max"
            for k in [VALUE_COL, VOLUME_COL, "Unit Price"]
            if k in df_processed.columns
        }
        if "Product Name (EN)" in df_processed.columns:
            measure_agg["Product Name (EN)"] = join_unique

        if group_keys:
            df_processed = df_processed.groupby(group_keys, as_index=False).agg(
                measure_agg
            )

    # Reorder columns (Post-Aggregation)
    df_processed = reorder_en_after_kr(df_processed)

    # 3. Summaries
    # Product Summary
    sum_keys = [
        "Product Name (KR)",
        CATEGORY_COL,
        EXPORTER_COL,
        ORIGIN_COUNTRY_COL,
        RAW_IMPORTER_COL,
        HSCODE_COL,
    ]
    sum_keys = [c for c in sum_keys if c in df_processed.columns]

    sum_agg = {k: "sum" for k in [VALUE_COL, VOLUME_COL] if k in df_processed.columns}
    if "Unit Price" in df_processed.columns:
        sum_agg["Unit Price"] = "max"
    if "Product Name (EN)" in df_processed.columns:
        sum_agg["Product Name (EN)"] = join_unique

    prod_summary = (
        df_processed.groupby(sum_keys)
        .agg(sum_agg)
        .reset_index()
        .sort_values(VALUE_COL, ascending=False)
    )
    prod_summary = reorder_en_after_kr(prod_summary)

    # Exporter Summaries
    exp_summary = (
        df_processed.groupby(EXPORTER_COL)
        .agg(
            {
                "Product Name (KR)": join_unique,
                CATEGORY_COL: join_unique,
                VALUE_COL: "sum",
                VOLUME_COL: "sum",
            }
        )
        .reset_index()
        .sort_values(VALUE_COL, ascending=False)
    )

    exp_detail = (
        df_processed.groupby(
            [EXPORTER_COL, "Product Name (KR)", "Product Name (EN)", CATEGORY_COL]
        )
        .agg({VALUE_COL: "sum", VOLUME_COL: "sum"})
        .reset_index()
        .sort_values([EXPORTER_COL, VALUE_COL], ascending=[True, False])
    )

    # 4. Save Analyzed
    analyzed_path = os.path.join(output_dir, f"analyzed_data_{today_str}.xlsx")
    
    # Use temp file for the multi-sheet writer
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp_path = tmp.name
        
    try:
        print(f" ... generating summarized report to temp: {tmp_path}")
        with pd.ExcelWriter(tmp_path, engine="openpyxl") as writer:
            prod_summary.to_excel(writer, sheet_name="제품별_합산", index=False)
            exp_summary.to_excel(writer, sheet_name="Exporter별_요약", index=False)
            exp_detail.to_excel(writer, sheet_name="Exporter별_상세", index=False)
            df_processed.to_excel(writer, sheet_name="원본데이터", index=False)
        
        # Move to final destination
        shutil.move(tmp_path, analyzed_path)
        print(f"Saved Analyzed: {analyzed_path}")
        
    except Exception as e:
        print(f"Failed to save {analyzed_path}: {e}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise e

    print(f"\n[Final Results]")
    print(f"Processed rows: {len(df_processed):,}")
    print(f"Unique products: {len(prod_summary)}")
    print(f"Unique exporters: {len(exp_summary)}")
    print("\nDone.")

    return {
        "raw_path": raw_path,
        "analyzed_path": analyzed_path,
        "total_files": len(input_files),
        "total_rows": len(df_processed),
    }


def main():
    # Setup Output
    base_dir = os.path.dirname(os.path.abspath(__file__))
    target_output_dir = os.path.join(base_dir, OUTPUT_DIR)

    # Load Inputs
    input_files = get_input_files()
    if not input_files:
        print("No input files found.")
        return

    try:
        process_tridge_files(input_files, target_output_dir)
    except Exception as e:
        print(f"Error during processing: {e}")


if __name__ == "__main__":
    main()
