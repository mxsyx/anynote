const { remote: { Menu, MenuItem }, handlers } = anynote

const menus = {
  collapseNote: new Menu(),
  collapseStar: new Menu(),
  collapseTag: new Menu()
}
 
menus.collapseNote.append(
  new MenuItem({
    label: '新建文件夹',
    click: () => {      
      handlers.folder.create({
        name: '新建文件夹'
      })
    }
  })
)

export function popupCollapseNote(
  e: React.MouseEvent<HTMLDivElement, MouseEvent>
): void {
  e.preventDefault()
  menus.collapseNote.popup()
}

export function popupCollapseStar(
  e: React.MouseEvent<HTMLUListElement, MouseEvent>
): void {
  e.preventDefault()
  menus.collapseStar.popup()
}

export function popupCollapseTag(
  e: React.MouseEvent<HTMLUListElement, MouseEvent>
): void {
  e.preventDefault()
  menus.collapseTag.popup()
}
