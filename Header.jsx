import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, ShoppingCart, User, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import logo from '../assets/ajlib_logo_general.png'

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <header className="bg-primary text-primary-foreground shadow-lg">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center space-x-2">
            <img src={logo} alt="Ajlib" className="h-8 w-auto" />
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-8">
            <Link to="/" className="hover:text-secondary transition-colors">الرئيسية</Link>
            <Link to="/products" className="hover:text-secondary transition-colors">المنتجات</Link>
            <Link to="/about" className="hover:text-secondary transition-colors">من نحن</Link>
            <Link to="/contact" className="hover:text-secondary transition-colors">اتصل بنا</Link>
          </nav>

          {/* Search Bar */}
          <div className="hidden md:flex items-center space-x-4 flex-1 max-w-md mx-8">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                type="text"
                placeholder="البحث عن المنتجات..."
                className="pl-10 bg-background text-foreground"
              />
            </div>
          </div>

          {/* User Actions */}
          <div className="flex items-center space-x-4">
            <Button 
              variant="ghost" 
              size="icon" 
              className="text-primary-foreground hover:text-secondary"
              onClick={() => navigate('/login')}
            >
              <User className="h-5 w-5" />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              className="text-primary-foreground hover:text-secondary relative"
              onClick={() => navigate('/cart')}
            >
              <ShoppingCart className="h-5 w-5" />
              <span className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground text-xs rounded-full h-5 w-5 flex items-center justify-center">
                0
              </span>
            </Button>

            {/* Mobile Menu Button */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden text-primary-foreground"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isMenuOpen && (
          <div className="md:hidden py-4 border-t border-primary-foreground/20">
            <nav className="flex flex-col space-y-4">
              <Link to="/" className="hover:text-secondary transition-colors" onClick={() => setIsMenuOpen(false)}>الرئيسية</Link>
              <Link to="/products" className="hover:text-secondary transition-colors" onClick={() => setIsMenuOpen(false)}>المنتجات</Link>
              <Link to="/about" className="hover:text-secondary transition-colors" onClick={() => setIsMenuOpen(false)}>من نحن</Link>
              <Link to="/contact" className="hover:text-secondary transition-colors" onClick={() => setIsMenuOpen(false)}>اتصل بنا</Link>
              <div className="pt-4">
                <Input
                  type="text"
                  placeholder="البحث عن المنتجات..."
                  className="bg-background text-foreground"
                />
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  )
}

export default Header

