import sys
import subprocess
try:
    from PIL import Image
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow", "--break-system-packages"])
    from PIL import Image

img = Image.open('public/nostratech.png').convert("RGBA")
datas = img.getdata()

newData = []
for item in datas:
    # Check if pixel is close to white
    if item[0] > 220 and item[1] > 220 and item[2] > 220:
        # replace with transparent
        newData.append((255, 255, 255, 0))
    else:
        newData.append(item)

img.putdata(newData)
img.save('public/nostratech.png', "PNG")
print("Image processed successfully")
