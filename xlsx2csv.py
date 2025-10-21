import pandas as pd

def xlsx2csv():
    data_xlsx = pd.read_excel('xlsxname.xlsx', index_col=0)
    data_xlsx.to_csv('tasks.csv', encoding='utf-8')
    
if __name__ == '__main__':
    xlsx2csv()