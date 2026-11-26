cd last
..\..\tools\bin\fred23jr -i -money -roomsh=JR -nochecksum -qmlprefix=../mscrolls/jinxter/itemicons ../jinxter
copy rooms.h ..\..\..\..\magnetic\roomsjinxter.h
copy rooms.kl ..\script\rooms.kl
copy qml.qrc ..\..\..\..\app\jinxter.qrc
cd ..\text
cp ../last/tmpguild.text magic.tmp
mkt magic
mv msginfo.i ../last
cd ..


